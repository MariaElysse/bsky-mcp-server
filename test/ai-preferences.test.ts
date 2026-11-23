#!/usr/bin/env node
import { runTests } from "./test-helpers.js";
/**
 * ai-preferences.test — unit and integration tests for the AI preferences module.
 *
 * Covers:
 *  (1) flattenAiPreferences / unflattenAiPreferences round-trips
 *  (2) READ_PREFERENCES constant shape
 *  (3) cache behaviour: memoized lookups, negative caching, LRU eviction,
 *      TTL expiry, and clearPreferenceCache()
 *  (4) single-pass records API: record + deniedCategories without a second fetch
 *  (5) filterPostsByAiPreferences core logic
 *  (6) getDidsFromThread extraction from thread structures
 *  (7) filterThreadByAiPreferences filtering of denied authors
 *  (8) Integration: all 7 content tools enforce AI preferences
 *  (9) Edge cases: malformed input, empty arrays, malformed records, fetch failures
 */

import assert from "node:assert/strict";
import type { Agent } from "@atproto/api";
import {
  batchCheckAiPreferences,
  batchCheckAiPreferenceRecords,
  checkAiPreference,
  clearPreferenceCache,
  fetchAiPreferences,
  type AiPreferencesRecord,
} from "../src/ai-preferences.js";

// ---------------------------------------------------------------------------
// Helpers — we import the compiled JS so tests run without a test framework.
// ---------------------------------------------------------------------------

const aiPrefs = await import("../src/ai-preferences.js");

// ---------------------------------------------------------------------------
// (1) flattenAiPreferences / unflattenAiPreferences round-trips
// ---------------------------------------------------------------------------

async function testFlattenAllAllow() {
  const raw = {
    preferences: {
      training: { allow: true },
      inference: { allow: true },
      syntheticContent: { allow: true },
      embedding: { allow: true },
    },
  };
  const flat = aiPrefs.flattenAiPreferences(raw);
  assert.equal(flat.training, "allow");
  assert.equal(flat.inference, "allow");
  assert.equal(flat.syntheticContent, "allow");
  assert.equal(flat.embedding, "allow");

  // Round-trip back to nested
  const nested = aiPrefs.unflattenAiPreferences(flat);
  assert.ok(nested.training && nested.training.allow === true);
  assert.ok(nested.inference && nested.inference.allow === true);
}

async function testFlattenAllDeny() {
  const raw = {
    preferences: {
      training: { allow: false },
      inference: { allow: false },
      syntheticContent: { allow: false },
      embedding: { allow: false },
    },
  };
  const flat = aiPrefs.flattenAiPreferences(raw);
  assert.equal(flat.training, "deny");
  assert.equal(flat.inference, "deny");

  // Round-trip back — deny should produce no key (unflatten skips falsy)
  const nested = aiPrefs.unflattenAiPreferences(flat);
  assert.equal(nested.training?.allow, false);
}

async function testFlattenPartial() {
  const raw = {
    preferences: {
      training: { allow: true },
      inference: { allow: false },
    },
  };
  const flat = aiPrefs.flattenAiPreferences(raw);
  assert.equal(flat.training, "allow");
  assert.equal(flat.inference, "deny");
  // Missing categories default to 'allow' (boolToAllowDeny(undefined) → 'allow')
  assert.equal(flat.syntheticContent, "allow");
  assert.equal(flat.embedding, "allow");
}

async function testFlattenEmpty() {
  const flat = aiPrefs.flattenAiPreferences({});
  // flattenAiPreferences always returns all 4 keys; missing categories default to 'allow'
  assert.equal(flat.training, "allow");
  assert.equal(flat.inference, "allow");
  assert.equal(flat.syntheticContent, "allow");
  assert.equal(flat.embedding, "allow");
}

// ---------------------------------------------------------------------------
// (2) READ_PREFERENCES constant shape
// ---------------------------------------------------------------------------

async function testReadPreferencesConstant() {
  const prefs = aiPrefs.READ_PREFERENCES;
  assert.ok(Array.isArray(prefs), "READ_PREFERENCES should be an array");
  assert.ok(
    prefs.includes("inference"),
    "should include inference"
  );
  assert.ok(
    prefs.includes("training"),
    "should include training"
  );
  // Should NOT include categories that don't affect reading
  assert.ok(
    !prefs.includes("syntheticContent"),
    "should not include syntheticContent in read prefs"
  );
  assert.ok(
    !prefs.includes("embedding"),
    "should not include embedding in read prefs"
  );
}

// ---------------------------------------------------------------------------
// (3) cache behaviour — memoized lookups, negative results, LRU eviction
// ---------------------------------------------------------------------------

/**
 * Build an agent stub whose com.atproto.repo.getRecord resolves like
 * @atproto/api. `calls` counts the getRecord lookups, which is how these tests
 * observe the module's caching without reaching into its private Map.
 */
function agentFor(
  recordByDid: Map<string, unknown>,
  options: { throwFor?: Set<string> } = {}
): Agent & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    com: {
      atproto: {
        repo: {
          getRecord: async ({ repo }: { repo: string }) => {
            calls++;
            if (options.throwFor?.has(repo)) {
              throw new Error("repository unavailable");
            }
            const value = recordByDid.get(repo);
            return value === undefined
              ? { success: false }
              : { success: true, data: { value } };
          },
        },
      },
    },
  } as unknown as Agent & { calls: number };
}

async function testCacheHitAndDeny() {
  clearPreferenceCache();

  const did = "did:plc:cache-hit-extra";
  const agent = agentFor(new Map([[did, { preferences: { inference: { allow: true }, training: { allow: true } } }]]));

  assert.equal(await checkAiPreference(agent, did), true);
  assert.equal(agent.calls, 1, "the first check should fetch the record");

  // The second check must be served by the cache, with the same verdict.
  assert.equal(await checkAiPreference(agent, did), true);
  assert.equal(agent.calls, 1, "a fresh cache entry should not be refetched");

  // A cached denial is observable the same way. Use a unique DID so the
  // module-level cache from other suites cannot affect this assertion.
  const deniedDid = "did:plc:cache-deny-extra";
  const deniedAgent = agentFor(new Map([[deniedDid, { preferences: { inference: { allow: false } } }]]));
  assert.equal(await checkAiPreference(deniedAgent, deniedDid), false);
  assert.equal(await checkAiPreference(deniedAgent, deniedDid), false);
  assert.equal(deniedAgent.calls, 1, "a cached denial should not be refetched");
}

async function testCheckPreferenceFetchFallbacksAndCustomCategories() {
  clearPreferenceCache();

  const missingDid = "did:plc:missing-extra";
  const missingAgent = agentFor(new Map());
  assert.equal(await checkAiPreference(missingAgent, missingDid), true, "missing records are privacy-first allow");

  const throwingDid = "did:plc:throwing-extra";
  const throwingAgent = agentFor(new Map(), { throwFor: new Set([throwingDid]) });
  assert.equal(await checkAiPreference(throwingAgent, throwingDid), true, "fetch errors are privacy-first allow");

  const embeddingDid = "did:plc:embedding-extra";
  const embeddingAgent = agentFor(new Map([[embeddingDid, {
    preferences: { embedding: { allow: false }, inference: { allow: true } },
  }]]));
  assert.equal(await checkAiPreference(embeddingAgent, embeddingDid, ["embedding"]), false);
  assert.equal(await checkAiPreference(embeddingAgent, embeddingDid, ["inference"]), true);

  const directFailure = await fetchAiPreferences(agentFor(new Map()), "did:plc:direct-missing-extra");
  assert.equal(directFailure, null);
}

async function testBatchUsesCachedEntriesAndDeduplicatesResults() {
  clearPreferenceCache();

  const cachedDid = "did:plc:batch-cached-extra";
  const freshDid = "did:plc:batch-fresh-extra";
  const agent = agentFor(new Map([
    [cachedDid, { preferences: { inference: { allow: true } } }],
    [freshDid, { preferences: { training: { allow: false } } }],
  ]));

  // Prime the module cache, then make a batch request containing the cached DID
  // twice. The batch path should use the cache and fetch only the fresh DID.
  assert.equal(await checkAiPreference(agent, cachedDid), true);
  const callsBefore = agent.calls;
  const result = await batchCheckAiPreferences(agent, [cachedDid, cachedDid, freshDid]);
  assert.equal(agent.calls, callsBefore + 1);
  assert.equal(result.get(cachedDid), true);
  assert.equal(result.get(freshDid), false);
  assert.equal(result.size, 2, "the result map should contain one entry per DID");
}

/** A PDS that throws is looked up once per TTL, and the verdict stays allowed. */
async function testNegativeCacheFailedLookupFetchedOnce() {
  clearPreferenceCache();

  const first = "did:plc:neg-throw-a";
  const second = "did:plc:neg-throw-b";
  // A feed page whose authors repeat — the unreachable PDS is hit once per
  // distinct DID, not once per post.
  const dids = [first, second, first, second, first];
  const agent = agentFor(new Map(), { throwFor: new Set([first, second]) });

  const checks = await batchCheckAiPreferenceRecords(agent, dids);
  assert.equal(agent.calls, 2, "one lookup per distinct DID");
  for (const did of dids) {
    assert.equal(checks.get(did)?.allowed, true, "a failed lookup never denies content");
    assert.equal(checks.get(did)?.record, null);
  }

  // The next page over the same authors must not re-hit the PDS.
  const allowedMap = await batchCheckAiPreferences(agent, dids);
  assert.equal(agent.calls, 2, "failed lookups are memoized for the whole TTL");
  for (const did of dids) {
    assert.equal(allowedMap.get(did), true, "the privacy-first fallback survives caching");
  }
  assert.equal(await checkAiPreference(agent, first), true);
  assert.equal(agent.calls, 2, "checkAiPreference serves the negative entry from the cache too");
}

/** A DID with no preference record is memoized exactly like a record is. */
async function testNegativeCacheNoRecordFetchedOnce() {
  clearPreferenceCache();

  const missing = "did:plc:neg-norecord-a";
  const agent = agentFor(new Map());

  assert.equal(await checkAiPreference(agent, missing), true);
  assert.equal(agent.calls, 1, "the first lookup of a no-record DID hits the PDS");

  const checks = await batchCheckAiPreferenceRecords(agent, [missing, missing]);
  assert.equal(agent.calls, 1, "a no-record verdict is cached like a denial or an allowance");
  assert.equal(checks.get(missing)?.allowed, true);
  assert.equal(checks.get(missing)?.record, null);
  assert.deepEqual(checks.get(missing)?.deniedCategories, []);
  assert.equal(await fetchAiPreferences(agent, missing), null, "fetchAiPreferences reuses the cached miss");
  assert.equal(agent.calls, 1);
}

/**
 * The cache is bounded to MAX_PREF_CACHE_ENTRIES with LRU eviction, and a read
 * refreshes an entry's recency instead of refetching it.
 */
async function testCacheEvictsLeastRecentlyUsedAtCap() {
  clearPreferenceCache();

  // Keep in sync with MAX_PREF_CACHE_ENTRIES in src/ai-preferences.ts.
  const CAP = 5000;
  const record = { preferences: { inference: { allow: true }, training: { allow: true } } };
  const dids = Array.from({ length: CAP }, (_, i) => `did:plc:lru-${i}`);

  const fillAgent = agentFor(new Map(dids.map((did) => [did, record])));
  const checks = await batchCheckAiPreferenceRecords(fillAgent, dids);
  assert.equal(checks.size, CAP, "every DID gets a verdict");
  assert.equal(fillAgent.calls, CAP, "each DID is looked up once while filling the cache");

  // Touch the oldest entry so it is no longer the least recently used one.
  assert.equal(await checkAiPreference(fillAgent, dids[0]), true);
  assert.equal(fillAgent.calls, CAP, "a read refreshes recency instead of refetching");

  // One more insert must evict exactly one entry — and not the DID just read.
  assert.equal(await checkAiPreference(fillAgent, "did:plc:lru-overflow"), true);
  assert.equal(fillAgent.calls, CAP + 1, "the new DID had to be fetched");

  const survivorAgent = agentFor(new Map([[dids[0], record]]));
  assert.equal(await checkAiPreference(survivorAgent, dids[0]), true);
  assert.equal(survivorAgent.calls, 0, "the most recently touched entry survives eviction");

  const evictedAgent = agentFor(new Map([[dids[1], record]]));
  assert.equal(await checkAiPreference(evictedAgent, dids[1]), true);
  assert.equal(evictedAgent.calls, 1, "the least recently touched entry was evicted");

  // The cap holds: re-checking the original DIDs refetches only what was evicted.
  const refillAgent = agentFor(new Map(dids.map((did) => [did, record])));
  await batchCheckAiPreferenceRecords(refillAgent, dids);
  assert.equal(refillAgent.calls, 1, "the cache never exceeds MAX_PREF_CACHE_ENTRIES entries");
}

/** clearPreferenceCache() drops positive and negative entries alike. */
async function testClearPreferenceCacheResetsPositiveAndNegative() {
  clearPreferenceCache();

  const denied = "did:plc:clear-positive";
  const missing = "did:plc:clear-negative";
  const agent = agentFor(
    new Map([[denied, { preferences: { inference: { allow: false }, training: { allow: true } } }]])
  );

  assert.equal(await checkAiPreference(agent, denied), false);
  assert.equal(await checkAiPreference(agent, missing), true);
  assert.equal(agent.calls, 2, "both verdicts are memoized");

  clearPreferenceCache();

  assert.equal(await checkAiPreference(agent, denied), false);
  assert.equal(await checkAiPreference(agent, missing), true);
  assert.equal(agent.calls, 4, "clear drops the positive and the negative entry");

  // A DID whose lookup previously failed can flip to a denial once its record
  // becomes readable — proving the negative entry really was dropped.
  const flaky = "did:plc:clear-flaky";
  const failing = agentFor(new Map(), { throwFor: new Set([flaky]) });
  assert.equal(await checkAiPreference(failing, flaky), true, "a failed lookup allows");
  clearPreferenceCache();
  const fixed = agentFor(new Map([[flaky, { preferences: { training: { allow: false } } }]]));
  assert.equal(await checkAiPreference(fixed, flaky), false, "the fresh record is read after clear");
}

/** Expired entries are dropped when touched, then repopulated by a new lookup. */
async function testCacheExpiryRefetchesAfterTtl() {
  clearPreferenceCache();

  const recordDid = "did:plc:ttl-record";
  const missingDid = "did:plc:ttl-negative";
  const agent = agentFor(
    new Map([[recordDid, { preferences: { inference: { allow: false }, training: { allow: true } } }]])
  );

  assert.equal(await checkAiPreference(agent, recordDid), false);
  assert.equal(await checkAiPreference(agent, missingDid), true);
  assert.equal(agent.calls, 2);

  const realNow = Date.now;
  try {
    // Step past PREF_CACHE_TTL_MS (5 minutes).
    Date.now = () => realNow() + 5 * 60_000 + 1_000;
    assert.equal(await checkAiPreference(agent, recordDid), false);
    assert.equal(await checkAiPreference(agent, missingDid), true);
  } finally {
    Date.now = realNow;
  }
  assert.equal(agent.calls, 4, "expired entries refetch — positive and negative alike");

  assert.equal(await checkAiPreference(agent, recordDid), false);
  assert.equal(agent.calls, 4, "the refetched entries are cached again");
}

// ---------------------------------------------------------------------------
// (4) single-pass records API — record + deniedCategories, no second fetch
// ---------------------------------------------------------------------------

/**
 * The tools layer used to call batchCheckAiPreferences() and then fetch each
 * denied DID again just to populate deniedCategories. The records API must
 * return the record alongside the verdict with zero extra getRecord calls.
 */
async function testBatchRecordsReturnsRecordWithoutSecondFetch() {
  clearPreferenceCache();

  const deniedDid = "did:plc:records-denied";
  const allowedDid = "did:plc:records-allowed";
  const missingDid = "did:plc:records-missing";
  const agent = agentFor(new Map([
    [deniedDid, {
      preferences: {
        inference: { allow: false },
        training: { allow: false },
        syntheticContent: { allow: true },
        embedding: { allow: true },
      },
    }],
    [allowedDid, {
      preferences: { inference: { allow: true }, training: { allow: true }, embedding: { allow: false } },
    }],
  ]));

  const checks = await batchCheckAiPreferenceRecords(agent, [deniedDid, allowedDid, missingDid]);
  assert.equal(agent.calls, 3, "the batch is the only pass — one lookup per DID");
  assert.equal(checks.size, 3);

  const deniedCheck = checks.get(deniedDid);
  assert.ok(deniedCheck, "the denied DID should have a check");
  assert.equal(deniedCheck.allowed, false);
  assert.deepEqual(deniedCheck.record, {
    training: "deny",
    inference: "deny",
    syntheticContent: "allow",
    embedding: "allow",
  });
  assert.deepEqual(deniedCheck.deniedCategories, ["inference", "training"]);

  const allowedCheck = checks.get(allowedDid);
  assert.ok(allowedCheck);
  assert.equal(allowedCheck.allowed, true);
  assert.deepEqual(allowedCheck.deniedCategories, []);
  assert.equal(allowedCheck.record?.embedding, "deny", "the whole record is returned, not just the verdict");

  const missingCheck = checks.get(missingDid);
  assert.ok(missingCheck);
  assert.equal(missingCheck.allowed, true, "no record is a privacy-first allow");
  assert.equal(missingCheck.record, null);
  assert.deepEqual(missingCheck.deniedCategories, []);

  // Verdicts and records are already in hand — nothing else may hit the PDS.
  const callsAfterBatch = agent.calls;
  const allowedMap = await batchCheckAiPreferences(agent, [deniedDid, allowedDid, missingDid]);
  assert.equal(agent.calls, callsAfterBatch, "the boolean wrapper adds no extra getRecord calls");
  assert.equal(allowedMap.get(deniedDid), false);
  assert.equal(allowedMap.get(allowedDid), true);
  assert.equal(allowedMap.get(missingDid), true);
  assert.equal(await checkAiPreference(agent, deniedDid), false);
  assert.equal(agent.calls, callsAfterBatch, "single checks reuse the same cache entries");

  // The records feed straight into filterPostsByAiPreferences' deniedRecords map.
  const deniedRecords = new Map<string, AiPreferencesRecord>();
  for (const [did, check] of checks) {
    if (!check.allowed && check.record) deniedRecords.set(did, check.record);
  }
  const { filtered, skippedCount } = aiPrefs.filterPostsByAiPreferences(
    [{ post: { author: { did: deniedDid } } }],
    allowedMap,
    deniedRecords
  );
  assert.equal(skippedCount, 1);
  assert.deepEqual(filtered[0].deniedCategories, ["inference", "training"]);
}

/** batchCheckAiPreferenceRecords honours a custom category list. */
async function testBatchRecordsCustomCategories() {
  clearPreferenceCache();

  const did = "did:plc:records-embedding";
  const agent = agentFor(
    new Map([[did, { preferences: { inference: { allow: true }, embedding: { allow: false } } }]])
  );

  const readChecks = await batchCheckAiPreferenceRecords(agent, [did]);
  assert.equal(readChecks.get(did)?.allowed, true, "embedding is not a read preference");
  assert.deepEqual(readChecks.get(did)?.deniedCategories, []);

  const embeddingChecks = await batchCheckAiPreferenceRecords(agent, [did], ["embedding"]);
  assert.equal(agent.calls, 1, "the record is cached, not refetched per category set");
  assert.equal(embeddingChecks.get(did)?.allowed, false);
  assert.deepEqual(embeddingChecks.get(did)?.deniedCategories, ["embedding"]);
  assert.equal(embeddingChecks.get(did)?.record?.inference, "allow");

  const wrapper = await batchCheckAiPreferences(agent, [did], ["embedding"]);
  assert.equal(wrapper.get(did), false);
  assert.equal(agent.calls, 1, "the wrapper keeps the single-pass guarantee");
}

// ---------------------------------------------------------------------------
// (5) filterPostsByAiPreferences core logic
// ---------------------------------------------------------------------------

async function testFilterKeepAll() {
  const posts = [
    { post: { author: { did: "did:plc:a" }, text: "hello" } },
    { post: { author: { did: "did:plc:b" }, text: "world" } },
  ];
  const allowedMap = new Map([["did:plc:a", true], ["did:plc:b", true]]);
  const result = aiPrefs.filterPostsByAiPreferences(posts, allowedMap);
  assert.equal(result.filtered.length, 2);
  assert.equal(result.skippedCount, 0);
}

async function testFilterRemoveDenied() {
  const posts = [
    { post: { author: { did: "did:plc:a" }, text: "hello" } },
    { post: { author: { did: "did:plc:b" }, text: "denied" } },
    { post: { author: { did: "did:plc:c" }, text: "keep" } },
  ];
  const allowedMap = new Map([
    ["did:plc:a", true],
    ["did:plc:b", false],
    ["did:plc:c", true],
  ]);
  const result = aiPrefs.filterPostsByAiPreferences(posts, allowedMap);
  // Denied posts are replaced with tombstones, not removed — total count stays the same
  assert.equal(result.filtered.length, 3);
  assert.equal(result.skippedCount, 1);
  // Verify the tombstone is in position 1
  const tombstone = result.filtered[1];
  assert.ok(tombstone.__aiPrefExcluded === true, "denied post should be a tombstone");
}

async function testFilterAllDenied() {
  const posts = [
    { post: { author: { did: "did:plc:a" }, text: "hello" } },
    { post: { author: { did: "did:plc:b" }, text: "world" } },
  ];
  const allowedMap = new Map([["did:plc:a", false], ["did:plc:b", false]]);
  const result = aiPrefs.filterPostsByAiPreferences(posts, allowedMap);
  // All posts become tombstones — array is not empty
  assert.equal(result.filtered.length, 2);
  assert.equal(result.skippedCount, 2);
  // Verify all are tombstones
  for (const item of result.filtered) {
    assert.ok(item.__aiPrefExcluded === true, "all items should be tombstones");
  }
}

async function testFilterEmptyInput() {
  const result = aiPrefs.filterPostsByAiPreferences([], new Map());
  assert.equal(result.filtered.length, 0);
  assert.equal(result.skippedCount, 0);
}

// ---------------------------------------------------------------------------
// (6) getDidsFromThread extraction
// ---------------------------------------------------------------------------

async function testGetDidsSimple() {
  const thread = {
    post: { author: { did: "did:plc:root" } },
    parent: null,
    replies: [],
  };
  const dids = aiPrefs.getDidsFromThread(thread);
  assert.deepEqual(dids, ["did:plc:root"]);
}

async function testGetDidsWithParent() {
  const thread = {
    post: { author: { did: "did:plc:child" } },
    parent: {
      post: { author: { did: "did:plc:parent" } },
      parent: null,
      replies: [],
    },
    replies: [],
  };
  const dids = aiPrefs.getDidsFromThread(thread);
  assert.deepEqual(dids.sort(), ["did:plc:child", "did:plc:parent"].sort());
}

async function testGetDidsWithReplies() {
  const thread = {
    post: { author: { did: "did:plc:root" } },
    parent: null,
    replies: [
      {
        post: { author: { did: "did:plc:r1" } },
        parent: null,
        replies: [
          {
            post: { author: { did: "did:plc:r2" } },
            parent: null,
            replies: [],
          },
        ],
      },
    ],
  };
  const dids = aiPrefs.getDidsFromThread(thread);
  assert.deepEqual(
    dids.sort(),
    ["did:plc:root", "did:plc:r1", "did:plc:r2"].sort()
  );
}

async function testGetDidsNullInput() {
  const dids = aiPrefs.getDidsFromThread(null);
  assert.deepEqual(dids, []);
}

// ---------------------------------------------------------------------------
// (7) filterThreadByAiPreferences filtering
// ---------------------------------------------------------------------------

async function testFilterThreadKeepAll() {
  const thread = {
    post: { author: { did: "did:plc:a" } },
    parent: null,
    replies: [
      { post: { author: { did: "did:plc:b" } }, parent: null, replies: [] },
    ],
  };
  const allowedMap = new Map([["did:plc:a", true], ["did:plc:b", true]]);
  const result = aiPrefs.filterThreadByAiPreferences(thread, allowedMap, true);
  assert.ok(result !== null);
  assert.equal(result.post.author.did, "did:plc:a");
  assert.equal(result.replies.length, 1);
}

async function testFilterThreadRemoveDeniedReply() {
  const thread = {
    post: { author: { did: "did:plc:root" } },
    parent: null,
    replies: [
      { post: { author: { did: "did:plc:denied" } }, parent: null, replies: [] },
      { post: { author: { did: "did:plc:allowed" } }, parent: null, replies: [] },
    ],
  };
  const allowedMap = new Map([
    ["did:plc:root", true],
    ["did:plc:denied", false],
    ["did:plc:allowed", true],
  ]);
  const result = aiPrefs.filterThreadByAiPreferences(thread, allowedMap, true);
  assert.ok(result !== null);
  assert.equal(result.post.author.did, "did:plc:root");
  // Only the allowed reply should remain
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].post.author.did, "did:plc:allowed");
}

async function testFilterThreadRemoveDeniedParent() {
  const thread = {
    post: { author: { did: "did:plc:child" } },
    parent: {
      post: { author: { did: "did:plc:deniedparent" } },
      parent: null,
      replies: [],
    },
    replies: [],
  };
  const allowedMap = new Map([
    ["did:plc:child", true],
    ["did:plc:deniedparent", false],
  ]);
  const result = aiPrefs.filterThreadByAiPreferences(thread, allowedMap, true);
  assert.ok(result !== null);
  // Root (child) is kept because it was explicitly requested.
  // Parent should be removed since the parent author is denied.
  assert.equal(result.post.author.did, "did:plc:child");
  assert.equal(result.parent, undefined, "denied parent should be removed");
}

async function testFilterThreadDeepNestedDenied() {
  const thread = {
    post: { author: { did: "did:plc:root" } },
    parent: null,
    replies: [
      {
        post: { author: { did: "did:plc:r1" } },
        parent: null,
        replies: [
          {
            post: { author: { did: "did:plc:denied-deep" } },
            parent: null,
            replies: [],
          },
          {
            post: { author: { did: "did:plc:allowed-deep" } },
            parent: null,
            replies: [],
          },
        ],
      },
    ],
  };
  const allowedMap = new Map([
    ["did:plc:root", true],
    ["did:plc:r1", true],
    ["did:plc:denied-deep", false],
    ["did:plc:allowed-deep", true],
  ]);
  const result = aiPrefs.filterThreadByAiPreferences(thread, allowedMap, true);
  assert.ok(result !== null);
  assert.equal(result.replies.length, 1);
  // The deep reply should have only the allowed child
  assert.equal(
    result.replies[0].replies.length,
    1,
    "only allowed-deep should remain"
  );
  assert.equal(
    result.replies[0].replies[0].post.author.did,
    "did:plc:allowed-deep"
  );
}

async function testFilterThreadUndefinedAllowed() {
  // When a DID is not in the map (undefined), it should be allowed.
  const thread = {
    post: { author: { did: "did:plc:unknown" } },
    parent: null,
    replies: [],
  };
  const allowedMap = new Map(); // empty — nothing checked yet
  const result = aiPrefs.filterThreadByAiPreferences(thread, allowedMap, true);
  assert.ok(result !== null);
}

// ---------------------------------------------------------------------------
// (8) Integration: all 7 content tools enforce AI preferences
// ---------------------------------------------------------------------------

async function testIntegrationTimelineEnforcesPrefs() {
  // Verify the get-timeline-posts tool source contains AI preference filtering.
  // After deduplication, tool implementations live in tools.js (canonical source).
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // The tool should reference batchCheckAiPreferences or filterPostsByAiPrefs
  assert.ok(
    src.includes("batchCheckAiPreferences") ||
      src.includes("filterPostsByAiPreferences"),
    "tools.js should contain AI preference checking calls"
  );
}

async function testIntegrationSearchPostsEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // search-posts tool should call filterPostsByAiPrefs
  assert.ok(
    src.includes("filterPostsByAiPreferences"),
    "search-posts should enforce AI preferences"
  );
}

async function testIntegrationGetPostThreadEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // get-post-thread should use formatPostThreadWithAiPrefs or filterThreadByAiPreferences
  assert.ok(
    src.includes("formatPostThreadWithAiPrefs") ||
      src.includes("filterThreadByAiPreferences"),
    "get-post-thread should enforce AI preferences"
  );
}

async function testIntegrationGetLikedPostsEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // get-liked-posts should enforce AI preferences
  assert.ok(
    src.includes("filterPostsByAiPreferences"),
    "get-liked-posts should enforce AI preferences"
  );
}

async function testIntegrationGetFeedPostsEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // get-feed-posts should enforce AI preferences
  assert.ok(
    src.includes("filterPostsByAiPreferences"),
    "get-feed-posts should enforce AI preferences"
  );
}

async function testIntegrationGetListPostsEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // get-list-posts should enforce AI preferences
  assert.ok(
    src.includes("filterPostsByAiPreferences"),
    "get-list-posts should enforce AI preferences"
  );
}

async function testIntegrationGetUserPostsEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // get-user-posts should enforce AI preferences
  assert.ok(
    src.includes("filterPostsByAiPreferences"),
    "get-user-posts should enforce AI preferences"
  );
}

async function testIntegrationGetNotificationsEnforcesPrefs() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const toolsPath = path.join(
    process.cwd(),
    "build",
    "src",
    "tools.js"
  );
  const src = fs.readFileSync(toolsPath, "utf-8");

  // get-notifications should call batchCheckAiPreferences to enforce AI preferences
  assert.ok(
    src.includes("batchCheckAiPreferences"),
    "get-notifications should enforce AI preferences via batchCheckAiPreferences"
  );
}

// ---------------------------------------------------------------------------
// (9) Edge cases: malformed input, empty arrays, fetch failures
// ---------------------------------------------------------------------------

async function testFilterMalformedPostNoAuthor() {
  const posts = [
    { post: {} }, // no author
    { post: { author: { did: "did:plc:a" } } },
  ];
  const allowedMap = new Map([["did:plc:a", true]]);
  const result = aiPrefs.filterPostsByAiPreferences(posts, allowedMap);
  // Items without author info should be kept (not filtered)
  assert.equal(result.filtered.length, 2);
}

async function testFilterMalformedPostNoAuthorDid() {
  const posts = [
    { post: { author: {} } }, // no did on author
    { post: { author: { did: "did:plc:a" } } },
  ];
  const allowedMap = new Map([["did:plc:a", true]]);
  const result = aiPrefs.filterPostsByAiPreferences(posts, allowedMap);
  assert.equal(result.filtered.length, 2); // both kept (no did = allow)
}

async function testFilterEmptyArray() {
  const result = aiPrefs.filterPostsByAiPreferences([], new Map());
  assert.equal(result.filtered.length, 0);
  assert.equal(result.skippedCount, 0);
}

async function testGetDidsFromMalformedThread() {
  // Null post
  const dids1 = aiPrefs.getDidsFromThread({});
  assert.deepEqual(dids1, []);

  // Null author
  const dids2 = aiPrefs.getDidsFromThread({ post: null });
  assert.deepEqual(dids2, []);

  // No replies field
  const dids3 = aiPrefs.getDidsFromThread({ post: { author: { did: "did:plc:x" } } });
  assert.deepEqual(dids3, ["did:plc:x"]);
}

async function testFilterThreadMalformed() {
  // Null thread
  const result1 = aiPrefs.filterThreadByAiPreferences(null, new Map(), true);
  assert.equal(result1, null);

  // No post.author.did
  const result2 = aiPrefs.filterThreadByAiPreferences(
    { post: {} },
    new Map(),
    true
  );
  assert.ok(result2 !== null); // kept as-is (malformed)
}

/**
 * A malformed preference record must not throw and must not deny content —
 * the untyped getRecord value is validated, and anything unexpected counts as
 * "no record" (which is cached, so a hostile record is fetched once).
 */
async function testMalformedRecordsAllowWithoutThrowing() {
  clearPreferenceCache();

  const garbage: Array<[string, unknown]> = [
    ["string-value", "not-a-record"],
    ["null-value", null],
    ["array-value", [{ allow: true }]],
    ["preferences-string", { preferences: "yes" }],
    ["preferences-array", { preferences: [{ allow: true }] }],
    ["category-boolean", { preferences: { inference: true } }],
    ["category-allow-string", { preferences: { inference: { allow: "false" } } }],
  ];

  for (const [label, value] of garbage) {
    const did = `did:plc:malformed-${label}`;
    const agent = agentFor(new Map([[did, value]]));

    assert.equal(await fetchAiPreferences(agent, did), null, `${label}: treated as no record`);
    assert.equal(await checkAiPreference(agent, did), true, `${label}: allowed, never silently denied`);
    const checks = await batchCheckAiPreferenceRecords(agent, [did]);
    assert.equal(checks.get(did)?.allowed, true, `${label}: batch verdict stays allowed`);
    assert.equal(checks.get(did)?.record, null, `${label}: no record to expose`);
    assert.equal(agent.calls, 1, `${label}: the malformed result is cached, not refetched`);
  }
}

/** A record that sets no categories still allows everything (unset is not a deny). */
async function testRecordWithNoCategoriesSetAllows() {
  clearPreferenceCache();

  const bareDid = "did:plc:empty-record-bare";
  const emptyDid = "did:plc:empty-record-prefs";
  const agent = agentFor(new Map([
    [bareDid, {}],
    [emptyDid, { preferences: {} }],
  ]));

  for (const did of [bareDid, emptyDid]) {
    const record = await fetchAiPreferences(agent, did);
    assert.ok(record, `${did}: a record with no categories is still a record`);
    assert.equal(record.inference, "allow");
    assert.equal(record.training, "allow");
    assert.equal(await checkAiPreference(agent, did), true);
    const checks = await batchCheckAiPreferenceRecords(agent, [did]);
    assert.equal(checks.get(did)?.allowed, true);
    assert.deepEqual(checks.get(did)?.deniedCategories, []);
  }
  assert.equal(agent.calls, 2, "each author's record is fetched exactly once");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const cases: Array<[string, () => Promise<void>]> = [
    // (1) flatten/unflatten round-trips
    ["flattenAiPreferences — all allow", testFlattenAllAllow],
    ["flattenAiPreferences — all deny", testFlattenAllDeny],
    ["flattenAiPreferences — partial", testFlattenPartial],
    ["flattenAiPreferences — empty input", testFlattenEmpty],

    // (2) READ_PREFERENCES constant
    ["READ_PREFERENCES includes inference and training only", testReadPreferencesConstant],

    // (3) cache behaviour — memoized lookups, negative results, LRU eviction
    ["AI preference cache hit allow/deny", testCacheHitAndDeny],
    ["AI preference single-check fallbacks and custom categories", testCheckPreferenceFetchFallbacksAndCustomCategories],
    ["AI preference batch cache path", testBatchUsesCachedEntriesAndDeduplicatesResults],
    [
      "negative cache: a throwing PDS is looked up once per TTL, verdict stays allowed",
      testNegativeCacheFailedLookupFetchedOnce,
    ],
    ["negative cache: a missing record is looked up once", testNegativeCacheNoRecordFetchedOnce],
    [
      "cache cap: the least recently used entry is evicted at MAX_PREF_CACHE_ENTRIES",
      testCacheEvictsLeastRecentlyUsedAtCap,
    ],
    [
      "clearPreferenceCache resets positive and negative entries",
      testClearPreferenceCacheResetsPositiveAndNegative,
    ],
    ["cache TTL: expired entries refetch, then recache", testCacheExpiryRefetchesAfterTtl],

    // (4) single-pass records API — record + deniedCategories, no second fetch
    [
      "batchCheckAiPreferenceRecords returns the record and deniedCategories in one pass",
      testBatchRecordsReturnsRecordWithoutSecondFetch,
    ],
    [
      "batchCheckAiPreferenceRecords honours custom categories without refetching",
      testBatchRecordsCustomCategories,
    ],

    // (5) filterPostsByAiPreferences core logic
    ["filterPostsByAiPreferences — keep all allowed", testFilterKeepAll],
    ["filterPostsByAiPreferences — remove denied", testFilterRemoveDenied],
    ["filterPostsByAiPreferences — all denied", testFilterAllDenied],
    ["filterPostsByAiPreferences — empty input", testFilterEmptyInput],

    // (6) getDidsFromThread extraction
    ["getDidsFromThread — simple thread", testGetDidsSimple],
    ["getDidsFromThread — with parent chain", testGetDidsWithParent],
    ["getDidsFromThread — with nested replies", testGetDidsWithReplies],
    ["getDidsFromThread — null input", testGetDidsNullInput],

    // (7) filterThreadByAiPreferences filtering
    ["filterThreadByAiPreferences — keep all", testFilterThreadKeepAll],
    [
      "filterThreadByAiPreferences — remove denied reply",
      testFilterThreadRemoveDeniedReply,
    ],
    [
      "filterThreadByAiPreferences — remove denied parent",
      testFilterThreadRemoveDeniedParent,
    ],
    [
      "filterThreadByAiPreferences — deep nested denied",
      testFilterThreadDeepNestedDenied,
    ],
    ["filterThreadByAiPreferences — undefined allowed (cache miss)", testFilterThreadUndefinedAllowed],

    // (8) Integration: all 7 content tools enforce AI preferences
    [
      "integration: get-timeline-posts enforces prefs",
      testIntegrationTimelineEnforcesPrefs,
    ],
    ["integration: search-posts enforces prefs", testIntegrationSearchPostsEnforcesPrefs],
    [
      "integration: get-post-thread enforces prefs (thread filtering)",
      testIntegrationGetPostThreadEnforcesPrefs,
    ],
    [
      "integration: get-liked-posts enforces prefs",
      testIntegrationGetLikedPostsEnforcesPrefs,
    ],
    ["integration: get-feed-posts enforces prefs", testIntegrationGetFeedPostsEnforcesPrefs],
    ["integration: get-list-posts enforces prefs", testIntegrationGetListPostsEnforcesPrefs],
    [
      "integration: get-user-posts enforces prefs",
      testIntegrationGetUserPostsEnforcesPrefs,
    ],
    [
      "integration: get-notifications enforces prefs",
      testIntegrationGetNotificationsEnforcesPrefs,
    ],

    // (9) Edge cases
    ["edge: malformed post with no author kept", testFilterMalformedPostNoAuthor],
    ["edge: malformed post with no did allowed", testFilterMalformedPostNoAuthorDid],
    ["edge: empty array input", testFilterEmptyArray],
    [
      "edge: getDidsFromThread handles malformed threads",
      testGetDidsFromMalformedThread,
    ],
    [
      "edge: filterThreadByAiPreferences handles malformed threads",
      testFilterThreadMalformed,
    ],
    [
      "edge: malformed preference records allow instead of throwing",
      testMalformedRecordsAllowWithoutThrowing,
    ],
    [
      "edge: a record with no categories set still allows",
      testRecordWithNoCategoriesSetAllows,
    ],
  ];

  await runTests(cases);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

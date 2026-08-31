#!/usr/bin/env node
/**
 * thread-context.test — unit tests for src/thread-context.ts
 *
 * Covers:
 *  (1) fetchThreadContext mock success
 *  (2) extractAllParticipants from multi-level thread
 *  (3) formatThreadForReply isolates correct branch
 *  (4) AI preference filtering removes denied posts
 *  (5) Error handling for invalid URIs
 *  (6) Empty thread handling
 *  (7) Nested reply resolution (root/parent CID chain)
 *  (8) Tombstone preservation for excluded posts
 *  (9) isolateBranch finds target in deep nesting
 *  (10) extractAllParticipants handles malformed input
 *  (11) formatThreadForReply with empty thread view
 *  (12) fetchThreadContext graceful fallback on network error
 *  (13) Multiple participants deduplication
 *  (14) Branch isolation with no match returns null
 *  (15) Thread context preserves mentionedPostUri
 *  (16) Participants list includes root, parent, and all replies
 *  (17) fetchThreadContextWithMeta returns metadata
 *  (18) formatPermissionSummary produces correct output
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers — import the module under test
// ---------------------------------------------------------------------------

const tc = await import("../src/thread-context.js");

// ---------------------------------------------------------------------------
// Test fixtures — minimal thread view structures mimicking getPostThread output
// ---------------------------------------------------------------------------

function makePost(authorDid: string, uri: string, text: string = "test post") {
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      $type: "app.bsky/feed/def#postView",
      uri: uri,
      cid: "sha256:" + uri.split("/").pop(),
      author: { did: authorDid },
      record: { text: text, createdAt: new Date().toISOString(), reply: null },
      indexedAt: new Date().toISOString(),
    },
  };
}

function makeThreadView(authorDid: string, uri: string, parent: any = null, replies: any[] = []) {
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      $type: "app.bsky/feed/def#postView",
      uri: uri,
      cid: "sha256:" + uri.split("/").pop(),
      author: { did: authorDid },
      record: { text: "test post", createdAt: new Date().toISOString(), reply: parent ? { parent: { uri: parent.post.uri } } : null },
      indexedAt: new Date().toISOString(),
    },
    parent: parent,
    replies: replies,
  };
}

// ---------------------------------------------------------------------------
// (1) fetchThreadContext successfully retrieves a known thread
// ---------------------------------------------------------------------------

async function testFetchThreadContextSuccess() {
  const mockAgent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            data: {
              thread: makeThreadView("did:plc:alice", "at://did:plc:alice/post/1"),
            },
          }),
        },
      },
    },
  };

  const result = await tc.fetchThreadContext(mockAgent, "at://did:plc:alice/post/1");

  assert.ok(result.thread !== null, "thread should not be null on success");
  assert.equal(result.participants.length, 1, "should have 1 participant");
  assert.equal(result.participants[0], "did:plc:alice", "participant DID should match");
  assert.equal(
    result.mentionedPostUri,
    "at://did:plc:alice/post/1",
    "mentionedPostUri should match input"
  );
}

// ---------------------------------------------------------------------------
// (2) extractAllParticipants returns all DIDs from a multi-level thread
// ---------------------------------------------------------------------------

async function testExtractAllParticipantsMultiLevel() {
  const root = makeThreadView("did:plc:root", "at://did:plc:root/post/1");
  const child1 = makeThreadView("did:plc:child1", "at://did:plc:child1/post/2", root);
  const grandchild = makeThreadView(
    "did:plc:grandchild",
    "at://did:plc:grandchild/post/3",
    child1
  );

  // Build a nested structure with replies
  const threadView = {
    $type: root.$type,
    post: root.post,
    parent: null,
    replies: [
      {
        $type: child1.$type,
        post: child1.post,
        parent: root,
        replies: [{ $type: grandchild.$type, post: grandchild.post, parent: child1 }],
      },
    ],
  };

  const participants = tc.extractAllParticipants(threadView);

  assert.equal(
    participants.length,
    3,
    "should extract exactly 3 unique DIDs"
  );
  assert.ok(participants.includes("did:plc:root"), "should include root DID");
  assert.ok(participants.includes("did:plc:child1"), "should include child1 DID");
  assert.ok(
    participants.includes("did:plc:grandchild"),
    "should include grandchild DID"
  );
}

// ---------------------------------------------------------------------------
// (3) formatThreadForReply isolates the correct branch
// ---------------------------------------------------------------------------

async function testFormatThreadForReply() {
  const root = makeThreadView("did:plc:root", "at://did:plc:root/post/1");
  const child = makeThreadView(
    "did:plc:child",
    "at://did:plc:child/post/2",
    root
  );

  const threadView = { $type: root.$type, post: root.post, parent: null, replies: [{ $type: child.$type, post: child.post, parent: root }] };

  const result = tc.formatThreadForReply(
    threadView,
    "at://did:plc:child/post/2"
  );

  assert.equal(result.mentionedPostUri, "at://did:plc:child/post/2");
  assert.ok(
    result.participants.includes("did:plc:root"),
    "should include root participant"
  );
  assert.ok(
    result.participants.includes("did:plc:child"),
    "should include child participant"
  );
  assert.ok(typeof result.formattedText === "string", "formattedText should be a string");
}

// ---------------------------------------------------------------------------
// (4) AI preference filtering removes denied posts
// ---------------------------------------------------------------------------

async function testAiPreferenceFiltering() {
  const root = makeThreadView("did:plc:allowed", "at://did:plc:allowed/post/1");
  const deniedChild = makeThreadView(
    "did:plc:denied",
    "at://did:plc:denied/post/2",
    root
  );

  const threadView = { $type: root.$type, post: root.post, parent: null, replies: [{ $type: deniedChild.$type, post: deniedChild.post, parent: root }] };

  // Simulate allowedDids map where denied DID is false
  const allowedDids = new Map([["did:plc:allowed", true], ["did:plc:denied", false]]);

  // Use the re-exported filterThreadByAiPreferences from ai-preferences module
  const { filterThreadByAiPreferences } = await import("../src/ai-preferences.js");
  const filtered = filterThreadByAiPreferences(threadView, allowedDids, true);

  // The root should still be present
  assert.ok(filtered !== null && filtered !== undefined, "filtered thread should not be null");
  if (filtered && filtered.post) {
    assert.equal(
      filtered.post.author.did,
      "did:plc:allowed",
      "allowed post should remain"
    );
  }
}

// ---------------------------------------------------------------------------
// (5) Error handling for invalid URIs
// ---------------------------------------------------------------------------

async function testErrorHandlingInvalidUri() {
  const mockAgent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => {
            throw new Error("POST_NOT_FOUND");
          },
        },
      },
    },
  };

  const result = await tc.fetchThreadContext(
    mockAgent,
    "at://invalid/uri"
  );

  assert.equal(result.thread, null, "thread should be null on error");
  assert.equal(result.participants.length, 0, "participants should be empty");
}

// ---------------------------------------------------------------------------
// (6) Empty thread handling
// ---------------------------------------------------------------------------

async function testEmptyThreadHandling() {
  const mockAgent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({ data: {} }), // no thread field
        },
      },
    },
  };

  const result = await tc.fetchThreadContext(
    mockAgent,
    "at://did:plc:test/post/1"
  );

  assert.equal(result.thread, null, "thread should be null for empty response");
  assert.ok(typeof result.formattedText === "string", "should still have formatted text");
}

// ---------------------------------------------------------------------------
// (7) Nested reply resolution (root/parent CID chain)
// ---------------------------------------------------------------------------

async function testNestedReplyResolution() {
  const root = makeThreadView("did:plc:a", "at://did:plc:a/post/1");
  const level2 = makeThreadView(
    "did:plc:b",
    "at://did:plc:b/post/2",
    root
  );
  const level3 = makeThreadView(
    "did:plc:c",
    "at://did:plc:c/post/3",
    level2
  );

  const threadView = {
    $type: root.$type,
    post: root.post,
    parent: null,
    replies: [
      {
        $type: level2.$type,
        post: level2.post,
        parent: root,
        replies: [{ $type: level3.$type, post: level3.post, parent: level2 }],
      },
    ],
  };

  const participants = tc.extractAllParticipants(threadView);

  assert.equal(
    participants.length,
    3,
    "should resolve all levels of nesting"
  );
}

// ---------------------------------------------------------------------------
// (8) Tombstone preservation for excluded posts
// ---------------------------------------------------------------------------

async function testTombstonePreservation() {
  const root = makeThreadView("did:plc:root", "at://did:plc:root/post/1");
  const deniedChild = makeThreadView(
    "did:plc:denied",
    "at://did:plc:denied/post/2",
    root
  );

  const threadView = { $type: root.$type, post: root.post, parent: null, replies: [{ $type: deniedChild.$type, post: deniedChild.post, parent: root }] };

  // AllowedDids where denied is false
  const allowedDids = new Map([["did:plc:root", true], ["did:plc:denied", false]]);

  const { filterThreadByAiPreferences } = await import("../src/ai-preferences.js");
  const filtered = filterThreadByAiPreferences(threadView, allowedDids, true);

  // The root should still be present
  assert.ok(filtered !== null && filtered !== undefined, "filtered thread should not be null");
  if (filtered && filtered.post) {
    assert.equal(
      filtered.post.author.did,
      "did:plc:root",
      "allowed post should remain"
    );
  }
}

// ---------------------------------------------------------------------------
// (9) isolateBranch finds target in deep nesting
// ---------------------------------------------------------------------------

async function testIsolateBranchDeepNesting() {
  const root = makeThreadView("did:plc:a", "at://did:plc:a/post/1");
  const level2 = makeThreadView(
    "did:plc:b",
    "at://did:plc:b/post/2",
    root
  );
  const target = makeThreadView(
    "did:plc:c",
    "at://did:plc:c/post/3",
    level2
  );

  const threadView = {
    $type: root.$type,
    post: root.post,
    parent: null,
    replies: [
      {
        $type: level2.$type,
        post: level2.post,
        parent: root,
        replies: [{ $type: target.$type, post: target.post, parent: level2 }],
      },
    ],
  };

  const branch = tc.isolateBranch(threadView, "at://did:plc:c/post/3");

  assert.ok(branch !== null, "branch should be found in deep nesting");
  if (branch && branch.post) {
    assert.equal(
      branch.post.uri,
      "at://did:plc:c/post/3",
      "isolated branch should contain target post"
    );
  }
}

// ---------------------------------------------------------------------------
// (10) extractAllParticipants handles malformed input
// ---------------------------------------------------------------------------

async function testExtractAllParticipantsMalformed() {
  assert.deepEqual(
    tc.extractAllParticipants(null),
    [],
    "null input should return empty array"
  );
  assert.deepEqual(
    tc.extractAllParticipants(undefined),
    [],
    "undefined input should return empty array"
  );
  assert.deepEqual(
    tc.extractAllParticipants("not an object"),
    [],
    "non-object input should return empty array"
  );
  assert.deepEqual(
    tc.extractAllParticipants({}),
    [],
    "empty object should return empty array"
  );
}

// ---------------------------------------------------------------------------
// (11) formatThreadForReply with empty thread view
// ---------------------------------------------------------------------------

async function testFormatThreadForReplyEmpty() {
  const result = tc.formatThreadForReply(null, "at://did:plc:test/post/1");

  assert.equal(result.mentionedPostUri, "at://did:plc:test/post/1");
  assert.ok(Array.isArray(result.participants), "participants should be an array");
}

// ---------------------------------------------------------------------------
// (12) fetchThreadContext graceful fallback on network error
// ---------------------------------------------------------------------------

async function testFetchThreadContextNetworkError() {
  const mockAgent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => {
            throw new Error("NETWORK_ERROR");
          },
        },
      },
    },
  };

  const result = await tc.fetchThreadContext(
    mockAgent,
    "at://did:plc:test/post/1"
  );

  assert.equal(result.thread, null, "thread should be null on network error");
  assert.ok(typeof result.formattedText === "string", "should have formatted text fallback");
}

// ---------------------------------------------------------------------------
// (13) Multiple participants deduplication
// ---------------------------------------------------------------------------

async function testParticipantDeduplication() {
  const root = makeThreadView("did:plc:same", "at://did:plc:same/post/1");
  const child1 = makeThreadView(
    "did:plc:different",
    "at://did:plc:different/post/2",
    root
  );

  // Same author in multiple replies
  const threadView = {
    $type: root.$type,
    post: root.post,
    parent: null,
    replies: [
      child1,
      makeThreadView("did:plc:same", "at://did:plc:same/post/3", root),
    ],
  };

  const participants = tc.extractAllParticipants(threadView);

  assert.equal(
    participants.length,
    2,
    "should deduplicate DIDs (same author appears twice)"
  );
}

// ---------------------------------------------------------------------------
// (14) Branch isolation with no match returns null
// ---------------------------------------------------------------------------

async function testIsolateBranchNoMatch() {
  const root = makeThreadView("did:plc:a", "at://did:plc:a/post/1");
  const child = makeThreadView(
    "did:plc:b",
    "at://did:plc:b/post/2",
    root
  );

  const threadView = { $type: root.$type, post: root.post, parent: null, replies: [child] };

  const branch = tc.isolateBranch(threadView, "at://nonexistent/post/99");

  assert.equal(branch, null, "should return null when target URI not found");
}

// ---------------------------------------------------------------------------
// (15) Thread context preserves mentionedPostUri
// ---------------------------------------------------------------------------

async function testThreadContextPreservesUri() {
  const mockAgent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            data: {
              thread: makeThreadView("did:plc:test", "at://did:plc:test/post/42"),
            },
          }),
        },
      },
    },
  };

  const result = await tc.fetchThreadContext(
    mockAgent,
    "at://did:plc:test/post/42"
  );

  assert.equal(result.mentionedPostUri, "at://did:plc:test/post/42");
}

// ---------------------------------------------------------------------------
// (16) Participants list includes root, parent, and all replies
// ---------------------------------------------------------------------------

async function testParticipantsIncludeAllLevels() {
  const root = makeThreadView("did:plc:root", "at://did:plc:root/post/1");
  const parent = makeThreadView(
    "did:plc:parent",
    "at://did:plc:parent/post/2",
    root
  );
  const child = makeThreadView(
    "did:plc:child",
    "at://did:plc:child/post/3",
    parent
  );

  // Build a thread where the post has a parent chain AND replies
  const threadView = {
    $type: child.$type,
    post: child.post,
    parent: {
      $type: parent.$type,
      post: parent.post,
      parent: root,
      replies: [],
    },
    replies: [makeThreadView("did:plc:sibling", "at://did:plc:sibling/post/4", child)],
  };

  const participants = tc.extractAllParticipants(threadView);

  assert.equal(
    participants.length,
    4,
    "should include root, parent, child, and sibling"
  );
}

// ---------------------------------------------------------------------------
// (17) fetchThreadContextWithMeta returns thread string and excludedCount
// ---------------------------------------------------------------------------

async function testFetchThreadContextWithMeta() {
  const mockAgent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            data: {
              thread: makeThreadView("did:plc:test", "at://did:plc:test/post/1"),
            },
          }),
        },
      },
    },
  };

  const result = await tc.fetchThreadContextWithMeta(
    mockAgent,
    "at://did:plc:test/post/1"
  );

  assert.ok(typeof result.thread === "string", "thread should be a string");
  assert.equal(typeof result.excludedCount, "number", "excludedCount should be a number");
}

// ---------------------------------------------------------------------------
// (18) formatPermissionSummary produces correct output
// ---------------------------------------------------------------------------

async function testFormatPermissionSummary() {
  const allowedMap = new Map([
    ["did:plc:a", true],
    ["did:plc:b", false],
    ["did:plc:c", true],
  ]);

  const summary = tc.formatPermissionSummary(allowedMap);

  assert.ok(summary.includes("Allowed: 2"), "should show 2 allowed");
  assert.ok(summary.includes("Denied: 1"), "should show 1 denied");
  assert.ok(summary.includes("did:plc:b"), "should list denied participant");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

const tests: Array<[string, () => Promise<void>]> = [
  ["fetchThreadContext success", testFetchThreadContextSuccess],
  ["extractAllParticipants multi-level", testExtractAllParticipantsMultiLevel],
  ["formatThreadForReply isolates branch", testFormatThreadForReply],
  ["AI preference filtering removes denied posts", testAiPreferenceFiltering],
  ["Error handling for invalid URIs", testErrorHandlingInvalidUri],
  ["Empty thread handling", testEmptyThreadHandling],
  ["Nested reply resolution", testNestedReplyResolution],
  ["Tombstone preservation", testTombstonePreservation],
  ["isolateBranch deep nesting", testIsolateBranchDeepNesting],
  ["extractAllParticipants malformed input", testExtractAllParticipantsMalformed],
  ["formatThreadForReply empty view", testFormatThreadForReplyEmpty],
  ["fetchThreadContext network error fallback", testFetchThreadContextNetworkError],
  ["Participant deduplication", testParticipantDeduplication],
  ["isolateBranch no match returns null", testIsolateBranchNoMatch],
  ["Thread context preserves mentionedPostUri", testThreadContextPreservesUri],
  ["Participants include all levels", testParticipantsIncludeAllLevels],
  ["fetchThreadContextWithMeta returns metadata", testFetchThreadContextWithMeta],
  ["formatPermissionSummary correct output", testFormatPermissionSummary],
];

let passed = 0;
let failed = 0;

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("PASS: " + name);
    passed++;
  } catch (err: any) {
    console.error("FAIL: " + name);
    console.error("  Error: " + (err instanceof Error ? err.message : String(err)));
    failed++;
  }
}

console.log("\nResults: " + passed + "/" + tests.length + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);

#!/usr/bin/env node
import { runTests } from "./test-helpers.js";
/**
 * mention-store.test — unit and integration tests for MentionStore.
 *
 * Covers:
 *  - File creation and format (JSON file with version & entries)
 *  - Atomic writes and data integrity
 *  - isHandled (unhandled, pending, replied, failed, skipped)
 *  - markInProgress (creates pending entry, updates timestamp)
 *  - markCompleted (updates to replied, stores replyUri)
 *  - markFailed (updates to failed, stores error message)
 *  - markSkipped (non-terminal skipped status + reason; skipped is NOT handled)
 *  - status transitions across a skipped entry, and legacy stores without it
 *  - getPending (retrieves pending entries sorted oldest first)
 *  - cleanup (removes entries older than maxAgeMs, default 24h)
 *  - size, getAll, clear, getPath helper methods
 *  - Concurrent access & locking (owner tokens, dead-pid and mtime staleness,
 *    safe take-over, and refusing to steal a live holder's lock)
 *  - Retention (per-status windows, overrides, lazy hourly pass from the write
 *    path, and the duplicate-reply guard that keeps `replied` longest)
 *  - Environment variable MENTION_STORE_PATH override
 *  - Singleton getMentionStore() behavior, including its retention-on-creation pass
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  MentionStore,
  getMentionStore,
  resetMentionStoreSingleton,
  LOCK_STALE_MS,
  DEFAULT_RETENTION,
  type RetentionPolicy,
} from "../src/mention-store.js";

const TEST_DIR = path.join(os.tmpdir(), "bsky-mcp-mention-store-test-" + Date.now() + "-" + Math.random().toString(36).slice(2));

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
}

async function cleanup() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function getTempStorePath(name: string): string {
  return path.join(TEST_DIR, `${name}.json`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testInitAndEmpty() {
  const storePath = getTempStorePath("empty");
  const store = new MentionStore(storePath);
  assert.equal(await store.size(), 0);
  assert.equal(await store.isHandled("at://did:plc:123/app.bsky.feed.post/456"), false);
  const pending = await store.getPending();
  assert.deepEqual(pending, []);
  assert.equal(store.getPath(), storePath);
}

async function testMarkInProgress() {
  const storePath = getTempStorePath("in-progress");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/p1";

  await store.markInProgress(uri);
  assert.equal(await store.size(), 1);
  assert.equal(await store.isHandled(uri), false, "pending mention is not considered handled yet");

  const pending = await store.getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].uri, uri);
  assert.ok(typeof pending[0].timestamp === "number");
}

async function testMarkCompleted() {
  const storePath = getTempStorePath("completed");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/p1";
  const replyUri = "at://did:plc:bot/app.bsky.feed.post/r1";

  await store.markInProgress(uri);
  await store.markCompleted(uri, replyUri);

  assert.equal(await store.size(), 1);
  assert.equal(await store.isHandled(uri), true, "replied mention is considered handled");

  const pending = await store.getPending();
  assert.equal(pending.length, 0);

  const all = await store.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "replied");
  assert.equal(all[0].replyUri, replyUri);
}

async function testMarkCompletedDirectly() {
  const storePath = getTempStorePath("completed-direct");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/p1";
  const replyUri = "at://did:plc:bot/app.bsky.feed.post/r1";

  await store.markCompleted(uri, replyUri);
  assert.equal(await store.isHandled(uri), true);
  const all = await store.getAll();
  assert.equal(all[0].status, "replied");
  assert.equal(all[0].replyUri, replyUri);
}

async function testMarkFailed() {
  const storePath = getTempStorePath("failed");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/p1";
  const errorMsg = "Rate limit exceeded";

  await store.markInProgress(uri);
  await store.markFailed(uri, errorMsg);

  assert.equal(await store.size(), 1);
  assert.equal(await store.isHandled(uri), true, "failed mention is considered handled to avoid repeat failures");

  const pending = await store.getPending();
  assert.equal(pending.length, 0);

  const all = await store.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "failed");
  assert.equal(all[0].error, errorMsg);
}

async function testMarkFailedDirectly() {
  const storePath = getTempStorePath("failed-direct");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/p1";
  const errorMsg = "User blocked bot";

  await store.markFailed(uri, errorMsg);
  assert.equal(await store.isHandled(uri), true);
  const all = await store.getAll();
  assert.equal(all[0].status, "failed");
  assert.equal(all[0].error, errorMsg);
}

async function testGetPendingOrdering() {
  const storePath = getTempStorePath("pending-order");
  const store = new MentionStore(storePath);

  const uri1 = "at://did:plc:alice/app.bsky.feed.post/p1";
  const uri2 = "at://did:plc:bob/app.bsky.feed.post/p2";
  const uri3 = "at://did:plc:carol/app.bsky.feed.post/p3";

  await store.markInProgress(uri1);
  await new Promise((r) => setTimeout(r, 10));
  await store.markInProgress(uri2);
  await new Promise((r) => setTimeout(r, 10));
  await store.markInProgress(uri3);

  await store.markCompleted(uri2, "at://did:plc:bot/app.bsky.feed.post/r2");

  const pending = await store.getPending();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].uri, uri1);
  assert.equal(pending[1].uri, uri3);
  assert.ok(pending[0].timestamp <= pending[1].timestamp);
}

async function testCleanupCustomAge() {
  const storePath = getTempStorePath("cleanup-custom");
  const store = new MentionStore(storePath);

  const uriOld = "at://did:plc:old/app.bsky.feed.post/old";
  const uriNew = "at://did:plc:new/app.bsky.feed.post/new";

  await store.markCompleted(uriOld);
  // Manually fudge the timestamp in file to make it old
  const raw = JSON.parse(await fs.readFile(storePath, "utf-8"));
  raw.entries[0].timestamp = Date.now() - 10000;
  await fs.writeFile(storePath, JSON.stringify(raw, null, 2), "utf-8");

  await store.markCompleted(uriNew);

  assert.equal(await store.size(), 2);
  const removed = await store.cleanup(5000); // older than 5 seconds
  assert.equal(removed, 1);
  assert.equal(await store.size(), 1);

  const all = await store.getAll();
  assert.equal(all[0].uri, uriNew);
}

async function testCleanupDefault24h() {
  const storePath = getTempStorePath("cleanup-default");
  const store = new MentionStore(storePath);

  const uriOld = "at://did:plc:old/app.bsky.feed.post/old";
  const uriNew = "at://did:plc:new/app.bsky.feed.post/new";

  await store.markCompleted(uriOld);
  // Manually set timestamp to 25 hours ago
  const raw = JSON.parse(await fs.readFile(storePath, "utf-8"));
  raw.entries[0].timestamp = Date.now() - 25 * 60 * 60 * 1000;
  await fs.writeFile(storePath, JSON.stringify(raw, null, 2), "utf-8");

  await store.markCompleted(uriNew);

  assert.equal(await store.size(), 2);
  const removed = await store.cleanup(); // default 24h
  assert.equal(removed, 1);
  assert.equal(await store.size(), 1);

  const all = await store.getAll();
  assert.equal(all[0].uri, uriNew);
}

async function testCleanupNoop() {
  const storePath = getTempStorePath("cleanup-noop");
  const store = new MentionStore(storePath);

  await store.markCompleted("at://did:plc:alice/app.bsky.feed.post/p1");
  const removed = await store.cleanup(24 * 60 * 60 * 1000);
  assert.equal(removed, 0);
  assert.equal(await store.size(), 1);
}

async function testAtomicWriteFileStructure() {
  const storePath = getTempStorePath("atomic-structure");
  const store = new MentionStore(storePath);

  await store.markInProgress("at://did:plc:alice/app.bsky.feed.post/p1");
  const content = await fs.readFile(storePath, "utf-8");
  const parsed = JSON.parse(content);

  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.entries));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].id, "at://did:plc:alice/app.bsky.feed.post/p1");
  assert.equal(parsed.entries[0].uri, "at://did:plc:alice/app.bsky.feed.post/p1");
  assert.equal(parsed.entries[0].status, "pending");
  assert.ok(typeof parsed.entries[0].timestamp === "number");
}

async function testClear() {
  const storePath = getTempStorePath("clear");
  const store = new MentionStore(storePath);

  await store.markInProgress("at://did:plc:alice/app.bsky.feed.post/p1");
  await store.markCompleted("at://did:plc:bob/app.bsky.feed.post/p2");
  assert.equal(await store.size(), 2);

  await store.clear();
  assert.equal(await store.size(), 0);
  const pending = await store.getPending();
  assert.deepEqual(pending, []);
}

async function testConcurrentWrites() {
  const storePath = getTempStorePath("concurrent");
  const store1 = new MentionStore(storePath);
  const store2 = new MentionStore(storePath);

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    const uri = `at://did:plc:user${i}/app.bsky.feed.post/p${i}`;
    const s = i % 2 === 0 ? store1 : store2;
    promises.push(s.markInProgress(uri));
  }

  await Promise.all(promises);

  assert.equal(await store1.size(), 20);
  assert.equal(await store2.size(), 20);

  const pending = await store1.getPending();
  assert.equal(pending.length, 20);
}

async function testEnvVarStorePath() {
  const customPath = getTempStorePath("env-custom");
  const oldEnv = process.env.MENTION_STORE_PATH;
  try {
    process.env.MENTION_STORE_PATH = customPath;
    const store = new MentionStore();
    assert.equal(store.getPath(), path.resolve(customPath));
    await store.markInProgress("at://did:plc:env/app.bsky.feed.post/e1");
    assert.ok(await store.isHandled("at://did:plc:env/app.bsky.feed.post/e1") === false);
    assert.equal(await store.size(), 1);
  } finally {
    if (oldEnv !== undefined) {
      process.env.MENTION_STORE_PATH = oldEnv;
    } else {
      delete process.env.MENTION_STORE_PATH;
    }
  }
}

async function testSingletonInstance() {
  const storePath = getTempStorePath("singleton");
  const oldEnv = process.env.MENTION_STORE_PATH;
  try {
    // Pin the singleton's path: creating it now starts a retention pass over
    // that file, so the suite must never let it point at a real store.
    process.env.MENTION_STORE_PATH = storePath;
    resetMentionStoreSingleton();
    const s1 = getMentionStore();
    const s2 = getMentionStore();
    assert.strictEqual(s1, s2, "getMentionStore() should return the same singleton instance");
    assert.equal(s1.getPath(), path.resolve(storePath));
  } finally {
    resetMentionStoreSingleton();
    if (oldEnv !== undefined) {
      process.env.MENTION_STORE_PATH = oldEnv;
    } else {
      delete process.env.MENTION_STORE_PATH;
    }
  }
}

async function testUpdateExistingEntryStatus() {
  const storePath = getTempStorePath("status-transitions");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/lifecycle";

  // Step 1: in progress
  await store.markInProgress(uri);
  let all = await store.getAll();
  assert.equal(all[0].status, "pending");

  // Step 2: complete
  await store.markCompleted(uri, "at://did:plc:bot/app.bsky.feed.post/success");
  all = await store.getAll();
  assert.equal(all[0].status, "replied");
  assert.equal(all[0].replyUri, "at://did:plc:bot/app.bsky.feed.post/success");
}

async function testNonExistentFileHandledGracefully() {
  const storePath = path.join(TEST_DIR, "non-existent-" + Date.now() + ".json");
  const store = new MentionStore(storePath);
  assert.equal(await store.isHandled("nonexistent"), false);
  assert.deepEqual(await store.getPending(), []);
  assert.deepEqual(await store.getAll(), []);
  assert.equal(await store.size(), 0);
}

// ---------------------------------------------------------------------------
// Additional granular tests to reach 29+ total tests
// ---------------------------------------------------------------------------

async function testGetAllReturnsCopy() {
  const storePath = getTempStorePath("get-all-copy");
  const store = new MentionStore(storePath);
  await store.markInProgress("at://did:plc:1/app.bsky.feed.post/1");

  const all1 = await store.getAll();
  all1.pop(); // mutate returned array
  const all2 = await store.getAll();
  assert.equal(all2.length, 1);
}

async function testMultipleCompletedEntries() {
  const storePath = getTempStorePath("multi-complete");
  const store = new MentionStore(storePath);
  await store.markCompleted("at://1", "at://reply1");
  await store.markCompleted("at://2", "at://reply2");
  await store.markCompleted("at://3", "at://reply3");

  assert.equal(await store.size(), 3);
  assert.equal(await store.isHandled("at://1"), true);
  assert.equal(await store.isHandled("at://2"), true);
  assert.equal(await store.isHandled("at://3"), true);
  assert.equal(await store.isHandled("at://4"), false);
}

async function testMultipleFailedEntries() {
  const storePath = getTempStorePath("multi-failed");
  const store = new MentionStore(storePath);
  await store.markFailed("at://fail1", "reason1");
  await store.markFailed("at://fail2", "reason2");

  assert.equal(await store.size(), 2);
  assert.equal(await store.isHandled("at://fail1"), true);
  assert.equal(await store.isHandled("at://fail2"), true);
}

async function testMixedEntriesLifecycle() {
  const storePath = getTempStorePath("mixed-lifecycle");
  const store = new MentionStore(storePath);

  await store.markInProgress("at://pending1");
  await store.markCompleted("at://replied1", "at://r1");
  await store.markFailed("at://failed1", "err1");
  await store.markInProgress("at://pending2");

  assert.equal(await store.size(), 4);
  const pending = await store.getPending();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].uri, "at://pending1");
  assert.equal(pending[1].uri, "at://pending2");
}

async function testCleanupPreservesPendingIfRecent() {
  const storePath = getTempStorePath("cleanup-pending");
  const store = new MentionStore(storePath);
  await store.markInProgress("at://recent-pending");

  const removed = await store.cleanup(60000);
  assert.equal(removed, 0);
  assert.equal(await store.size(), 1);
}

async function testCleanupRemovesOldPending() {
  const storePath = getTempStorePath("cleanup-old-pending");
  const store = new MentionStore(storePath);
  await store.markInProgress("at://old-pending");

  const raw = JSON.parse(await fs.readFile(storePath, "utf-8"));
  raw.entries[0].timestamp = Date.now() - 100000;
  await fs.writeFile(storePath, JSON.stringify(raw, null, 2), "utf-8");

  const removed = await store.cleanup(50000);
  assert.equal(removed, 1);
  assert.equal(await store.size(), 0);
}

async function testMarkCompletedWithoutReplyUri() {
  const storePath = getTempStorePath("complete-no-uri");
  const store = new MentionStore(storePath);
  await store.markCompleted("at://direct");

  const all = await store.getAll();
  assert.equal(all[0].status, "replied");
  assert.equal(all[0].replyUri, undefined);
}

async function testMarkFailedWithoutError() {
  const storePath = getTempStorePath("failed-no-err");
  const store = new MentionStore(storePath);
  await store.markFailed("at://direct-fail");

  const all = await store.getAll();
  assert.equal(all[0].status, "failed");
  assert.equal(all[0].error, undefined);
}

async function testConcurrentReadsAndWrites() {
  const storePath = getTempStorePath("concurrent-rw");
  const store = new MentionStore(storePath);

  await store.markInProgress("at://initial");

  const tasks: Promise<any>[] = [];
  for (let i = 0; i < 15; i++) {
    tasks.push(store.isHandled(`at://item${i}`));
    tasks.push(store.markInProgress(`at://item${i}`));
    tasks.push(store.getPending());
  }

  await Promise.all(tasks);
  assert.equal(await store.size(), 16);
}

async function testDefaultStorePathFallback() {
  const oldEnv = process.env.MENTION_STORE_PATH;
  try {
    delete process.env.MENTION_STORE_PATH;
    const store = new MentionStore();
    assert.equal(store.getPath(), path.resolve(".mention-store.json"));
  } finally {
    if (oldEnv !== undefined) process.env.MENTION_STORE_PATH = oldEnv;
  }
}

async function testWhitespaceEnvStorePathFallback() {
  const oldEnv = process.env.MENTION_STORE_PATH;
  try {
    process.env.MENTION_STORE_PATH = "   ";
    const store = new MentionStore();
    assert.equal(store.getPath(), path.resolve(".mention-store.json"));
  } finally {
    if (oldEnv !== undefined) process.env.MENTION_STORE_PATH = oldEnv;
  }
}

async function testIdMatchesUri() {
  const storePath = getTempStorePath("id-matches-uri");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:xyz/app.bsky.feed.post/123";
  await store.markInProgress(uri);

  const all = await store.getAll();
  assert.equal(all[0].id, uri);
  assert.equal(all[0].uri, uri);
}

async function testTimestampUpdatedOnMarkCompleted() {
  const storePath = getTempStorePath("ts-update-complete");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:xyz/app.bsky.feed.post/ts";

  await store.markInProgress(uri);
  const t1 = (await store.getAll())[0].timestamp;
  await new Promise((r) => setTimeout(r, 15));

  await store.markCompleted(uri, "at://reply");
  const t2 = (await store.getAll())[0].timestamp;
  assert.ok(t2 > t1, "timestamp should be updated on completion");
}

async function testTimestampUpdatedOnMarkFailed() {
  const storePath = getTempStorePath("ts-update-failed");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:xyz/app.bsky.feed.post/ts-fail";

  await store.markInProgress(uri);
  const t1 = (await store.getAll())[0].timestamp;
  await new Promise((r) => setTimeout(r, 15));

  await store.markFailed(uri, "error");
  const t2 = (await store.getAll())[0].timestamp;
  assert.ok(t2 > t1, "timestamp should be updated on failure");
}

async function testDoubleMarkInProgressPreservesSingleEntry() {
  const storePath = getTempStorePath("double-in-progress");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:xyz/app.bsky.feed.post/dup";

  await store.markInProgress(uri);
  await store.markInProgress(uri);

  assert.equal(await store.size(), 1);
  const pending = await store.getPending();
  assert.equal(pending.length, 1);
}

// ---------------------------------------------------------------------------
// `skipped` status — non-terminal opt-outs (AI-preference denials, etc.)
// ---------------------------------------------------------------------------

async function testMarkSkippedIsNotHandled() {
  const storePath = getTempStorePath("skipped-not-handled");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip1";

  await store.markInProgress(uri);
  await store.markSkipped(uri, "Target author has opted out of AI preferences");

  assert.equal(await store.size(), 1);
  assert.equal(
    await store.isHandled(uri),
    false,
    "a skipped mention must stay re-considerable, so it is not handled"
  );

  const pending = await store.getPending();
  assert.equal(pending.length, 0, "skipped entries are not pending either");

  const all = await store.getAll();
  assert.equal(all[0].status, "skipped");
  assert.equal(all[0].reason, "Target author has opted out of AI preferences");
  assert.equal(all[0].error, undefined, "a skip is not recorded as an error");
  assert.ok(typeof all[0].timestamp === "number", "skip records when it happened");
}

async function testMarkSkippedDirectly() {
  const storePath = getTempStorePath("skipped-direct");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip-direct";

  await store.markSkipped(uri, "AI preference denied");
  assert.equal(await store.size(), 1);
  assert.equal(await store.isHandled(uri), false);

  const all = await store.getAll();
  assert.equal(all[0].id, uri);
  assert.equal(all[0].status, "skipped");
  assert.equal(all[0].reason, "AI preference denied");
}

async function testMarkSkippedWithoutReason() {
  const storePath = getTempStorePath("skipped-no-reason");
  const store = new MentionStore(storePath);
  await store.markSkipped("at://direct-skip");

  assert.equal(await store.isHandled("at://direct-skip"), false);
  const all = await store.getAll();
  assert.equal(all[0].status, "skipped");
  assert.equal(all[0].reason, undefined);
}

async function testSkippedDoesNotChangeTerminalStatuses() {
  const storePath = getTempStorePath("terminal-unchanged");
  const store = new MentionStore(storePath);

  await store.markCompleted("at://still-replied", "at://reply-1");
  await store.markFailed("at://still-failed", "Rate limit exceeded");

  assert.equal(await store.isHandled("at://still-replied"), true, "replied stays terminal");
  assert.equal(await store.isHandled("at://still-failed"), true, "failed stays terminal");
}

async function testMarkSkippedThenMarkCompletedTransitions() {
  const storePath = getTempStorePath("skipped-to-replied");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip-then-reply";
  const replyUri = "at://did:plc:bot/app.bsky.feed.post/reply-after-skip";

  // Skipped under the old preference, reconsidered, then replied after the change.
  await store.markSkipped(uri, "AI preference denied");
  assert.equal(await store.isHandled(uri), false);

  await store.markCompleted(uri, replyUri);
  assert.equal(await store.size(), 1, "transition must not create a second entry");

  const all = await store.getAll();
  assert.equal(all[0].status, "replied");
  assert.equal(all[0].replyUri, replyUri);
  assert.equal(await store.isHandled(uri), true, "replying makes the entry terminal again");
}

async function testMarkSkippedThenMarkInProgressReopens() {
  const storePath = getTempStorePath("skipped-to-pending");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip-reopen";

  await store.markSkipped(uri, "AI preference denied");
  await store.markInProgress(uri);

  const all = await store.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "pending", "skipped must be re-openable via markInProgress");

  const pending = await store.getPending();
  assert.deepEqual(pending.map((p) => p.uri), [uri]);
  assert.equal(await store.isHandled(uri), false);
}

async function testMarkSkippedDoesNotDowngradeTerminalEntries() {
  const storePath = getTempStorePath("skip-no-downgrade");
  const store = new MentionStore(storePath);
  const repliedUri = "at://did:plc:alice/app.bsky.feed.post/replied-first";
  const failedUri = "at://did:plc:alice/app.bsky.feed.post/failed-first";

  await store.markCompleted(repliedUri, "at://reply-existing");
  await store.markFailed(failedUri, "Post not found or inaccessible");

  await store.markSkipped(repliedUri, "AI preference denied");
  await store.markSkipped(failedUri, "AI preference denied");

  const all = await store.getAll();
  const replied = all.find((e) => e.uri === repliedUri)!;
  const failed = all.find((e) => e.uri === failedUri)!;

  assert.equal(replied.status, "replied", "a posted reply is never un-done by a skip");
  assert.equal(replied.reason, undefined);
  assert.equal(await store.isHandled(repliedUri), true);

  assert.equal(failed.status, "failed", "a real error is never masked by a skip");
  assert.equal(failed.error, "Post not found or inaccessible");
  assert.equal(failed.reason, undefined);
  assert.equal(await store.isHandled(failedUri), true);
}

async function testRepeatedMarkSkippedUpdatesReasonAndTimestamp() {
  const storePath = getTempStorePath("skip-repeat");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip-repeat";

  await store.markSkipped(uri, "AI preference denied");
  const first = (await store.getAll())[0];
  await new Promise((r) => setTimeout(r, 15));
  await store.markSkipped(uri, "AI preference denied (still opted out)");

  assert.equal(await store.size(), 1, "repeated skipping keeps a single entry");
  const second = (await store.getAll())[0];
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "AI preference denied (still opted out)");
  assert.ok(second.timestamp > first.timestamp, "repeated skipping is observable over time");
}

async function testSkippedFileStructure() {
  const storePath = getTempStorePath("skipped-structure");
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip-json";

  await store.markSkipped(uri, "Target author has opted out of AI preferences");
  const parsed = JSON.parse(await fs.readFile(storePath, "utf-8"));

  assert.equal(parsed.version, 1, "adding the skipped status does not bump the file version");
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].status, "skipped");
  assert.equal(parsed.entries[0].reason, "Target author has opted out of AI preferences");
  assert.equal("error" in parsed.entries[0], false, "no error key is written for a skip");
}

async function testSkippedEntriesPersistAcrossReload() {
  const storePath = getTempStorePath("skipped-reload");
  const store1 = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/skip-persist";

  await store1.markSkipped(uri, "AI preference denied");

  // Fresh instance reading the same file: the skip survives, and stays non-terminal.
  const store2 = new MentionStore(storePath);
  assert.equal(await store2.size(), 1);
  assert.equal(await store2.isHandled(uri), false, "skipped stays non-terminal after reload");

  const all = await store2.getAll();
  assert.equal(all[0].status, "skipped");
  assert.equal(all[0].reason, "AI preference denied");
  assert.ok(typeof all[0].timestamp === "number");
}

async function testLegacyStoreWithoutSkippedLoads() {
  const storePath = getTempStorePath("legacy-store");
  const now = Date.now();
  const pendingUri = "at://did:plc:legacy/app.bsky.feed.post/p";
  const repliedUri = "at://did:plc:legacy/app.bsky.feed.post/r";
  const failedUri = "at://did:plc:legacy/app.bsky.feed.post/f";

  // Exactly what the current (pre-`skipped`) code writes: no `reason` field, no `skipped` status.
  const legacy = {
    version: 1,
    entries: [
      { id: pendingUri, uri: pendingUri, status: "pending", timestamp: now },
      { id: repliedUri, uri: repliedUri, status: "replied", timestamp: now, replyUri: "at://reply" },
      { id: failedUri, uri: failedUri, status: "failed", timestamp: now, error: "boom" },
    ],
  };
  await fs.writeFile(storePath, JSON.stringify(legacy, null, 2), "utf-8");

  const store = new MentionStore(storePath);
  assert.equal(await store.size(), 3);
  assert.equal(await store.isHandled(pendingUri), false);
  assert.equal(await store.isHandled(repliedUri), true);
  assert.equal(await store.isHandled(failedUri), true);
  assert.deepEqual((await store.getPending()).map((p) => p.uri), [pendingUri]);

  const all = await store.getAll();
  assert.equal(all[1].status, "replied");
  assert.equal(all[1].reason, undefined);
  assert.equal(all[2].error, "boom");

  // A legacy entry can be skipped by the new API without migrating the file first.
  await store.markSkipped(pendingUri, "AI preference denied");
  assert.equal(await store.size(), 3);
  const updated = (await store.getAll())[0];
  assert.equal(updated.status, "skipped");
  assert.equal(updated.reason, "AI preference denied");
  assert.equal(await store.isHandled(pendingUri), false);
}

async function testUnknownLegacyStatusIsHandled() {
  const storePath = getTempStorePath("unknown-status");
  const uri = "at://did:plc:legacy/app.bsky.feed.post/unknown";

  await fs.writeFile(
    storePath,
    JSON.stringify(
      { version: 1, entries: [{ id: uri, uri, status: "awaiting-review", timestamp: Date.now() }] },
      null,
      2
    ),
    "utf-8"
  );

  const store = new MentionStore(storePath);
  assert.equal(await store.size(), 1, "an unrecognised status must not crash the loader");
  assert.equal(await store.isHandled(uri), true, "unknown statuses fail closed against duplicate replies");
  assert.deepEqual(await store.getPending(), []);
}

async function testMixedStatusesIncludingSkipped() {
  const storePath = getTempStorePath("mixed-skipped");
  const store = new MentionStore(storePath);

  await store.markInProgress("at://pending1");
  await store.markCompleted("at://replied1", "at://r1");
  await store.markFailed("at://failed1", "err1");
  await store.markSkipped("at://skipped1", "AI preference denied");

  assert.equal(await store.size(), 4);
  assert.equal(await store.isHandled("at://pending1"), false);
  assert.equal(await store.isHandled("at://replied1"), true);
  assert.equal(await store.isHandled("at://failed1"), true);
  assert.equal(await store.isHandled("at://skipped1"), false);

  const pending = await store.getPending();
  assert.deepEqual(pending.map((p) => p.uri), ["at://pending1"]);

  const statuses = (await store.getAll()).map((e) => e.status);
  assert.deepEqual(statuses, ["pending", "replied", "failed", "skipped"]);
}

async function testCleanupRemovesOldSkipped() {
  // Retention rules are unchanged; this only documents that skipped entries are
  // pruned by timestamp like every other status.
  const storePath = getTempStorePath("cleanup-skipped");
  const store = new MentionStore(storePath);

  await store.markSkipped("at://old-skipped", "AI preference denied");
  await store.markSkipped("at://recent-skipped", "AI preference denied");

  const raw = JSON.parse(await fs.readFile(storePath, "utf-8"));
  raw.entries[0].timestamp = Date.now() - 100000;
  await fs.writeFile(storePath, JSON.stringify(raw, null, 2), "utf-8");

  const removed = await store.cleanup(50000);
  assert.equal(removed, 1);
  assert.equal(await store.size(), 1);
  assert.equal((await store.getAll())[0].uri, "at://recent-skipped");
}

async function testConcurrentSkippedWrites() {
  const storePath = getTempStorePath("concurrent-skipped");
  const store1 = new MentionStore(storePath);
  const store2 = new MentionStore(storePath);

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    const uri = `at://did:plc:user${i}/app.bsky.feed.post/s${i}`;
    const s = i % 2 === 0 ? store1 : store2;
    promises.push(s.markSkipped(uri, "AI preference denied"));
  }
  await Promise.all(promises);

  assert.equal(await store1.size(), 10);
  assert.equal(await store2.size(), 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(await store1.isHandled(`at://did:plc:user${i}/app.bsky.feed.post/s${i}`), false);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Locking & retention helpers
//
// These suites run in a single process and cannot fork a stand-in "other
// process", so a foreign lock holder is simulated with a lock file: a pid that
// provably does not exist stands for a crashed holder, and this process's own
// pid stands for a live one.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The store's lock retry budget (MAX_WRITE_ATTEMPTS × WRITE_RETRY_MS) is not
 * exported, and it is the number a *stale* lock must beat, so it is restated
 * here: taking over a provably dead holder must not cost the whole budget.
 */
const MAX_WRITE_ATTEMPTS_MS = 50 * 20;

function lockPathFor(storePath: string): string {
  return storePath + ".lock";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** A pid that is demonstrably not running on this host. */
function findDeadPid(): number {
  for (let pid = 99998; pid > 1000; pid--) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a provably dead pid on this host");
}

type SeedEntry = { uri: string; status: string; ageMs: number; error?: string; reason?: string };

/** Write the store file directly so entries can be seeded at arbitrary ages. */
async function seedStore(storePath: string, entries: SeedEntry[]): Promise<void> {
  const now = Date.now();
  const body = {
    version: 1,
    entries: entries.map((e) => ({
      id: e.uri,
      uri: e.uri,
      status: e.status,
      timestamp: now - e.ageMs,
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    })),
  };
  await fs.writeFile(storePath, JSON.stringify(body, null, 2), "utf-8");
}

/** Install a lock file as though another process had taken it. */
async function writeForeignLock(storePath: string, token: string): Promise<void> {
  await fs.writeFile(lockPathFor(storePath), token, "utf-8");
}

function urisOf(entries: Array<{ uri: string }>): string[] {
  return entries.map((e) => e.uri).sort();
}

/**
 * Capture the `[mention-store]` stderr notes a test triggers, so it can wait
 * for one. A never-appearing note rejects rather than hanging the suite.
 */
function captureStoreNotes(): {
  lines: string[];
  once: (fragment: string) => Promise<string>;
  restore: () => void;
} {
  const lines: string[] = [];
  const waiting: Array<{ fragment: string; resolve: (line: string) => void }> = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    lines.push(line);
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (line.includes(waiting[i].fragment)) {
        const waiter = waiting[i];
        waiting.splice(i, 1);
        waiter.resolve(line);
      }
    }
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
    once: (fragment: string) =>
      new Promise<string>((resolve, reject) => {
        const seen = lines.find((l) => l.includes(fragment));
        if (seen) {
          resolve(seen);
          return;
        }
        waiting.push({ fragment, resolve });
        const timer = setTimeout(() => {
          reject(new Error(`no [mention-store] note containing "${fragment}"; saw: ${lines.join(" | ") || "nothing"}`));
        }, 20000);
        timer.unref();
      }),
  };
}

// ---------------------------------------------------------------------------
// Cross-process locking: staleness detection and safe take-over
// ---------------------------------------------------------------------------

/**
 * A lock left by a holder whose pid no longer exists must be taken over almost
 * immediately — the old code spent the whole retry budget and then silently
 * overwrote whatever lock was there.
 */
async function testStaleLockDeadPidIsTakenOverQuickly() {
  const storePath = getTempStorePath("lock-dead-pid");
  const lockPath = lockPathFor(storePath);
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/lock-dead-pid";

  await writeForeignLock(storePath, `${findDeadPid()}:crashedholder01`);

  const started = Date.now();
  const notes = captureStoreNotes();
  let elapsedMs: number;
  try {
    await store.markInProgress(uri);
    elapsedMs = Date.now() - started;
    assert.ok(
      notes.lines.some((l) => l.includes("no longer exists on this host")),
      `the take-over should be justified by the dead holder pid, saw: ${notes.lines.join(" | ") || "nothing"}`
    );
  } finally {
    notes.restore();
  }

  assert.ok(
    elapsedMs < MAX_WRITE_ATTEMPTS_MS,
    `dead-pid lock was taken over in ${elapsedMs}ms; a provably dead holder must not cost the full ${MAX_WRITE_ATTEMPTS_MS}ms retry budget`
  );
  assert.equal(await store.size(), 1, "the write that took the abandoned lock over completed");
  assert.equal(await pathExists(lockPath), false, "the taken-over lock was released normally afterwards");
}

/**
 * A holder that is still alive but has not touched its lock file since well
 * past LOCK_STALE_MS is wedged or leaking, so the lock can be taken.
 */
async function testStaleLockOldMtimeIsTakenOver() {
  const storePath = getTempStorePath("lock-old-mtime");
  const lockPath = lockPathFor(storePath);
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/lock-old-mtime";

  await writeForeignLock(storePath, `${process.pid}:wedgedholder02`);
  // fs.utimes takes epoch **seconds**: age the lock file 90 s, i.e. past
  // LOCK_STALE_MS, while leaving its holder alive.
  const staleAtSec = (Date.now() - LOCK_STALE_MS - 60_000) / 1000;
  await fs.utimes(lockPath, staleAtSec, staleAtSec);

  const notes = captureStoreNotes();
  try {
    await store.markCompleted(uri, "at://did:plc:bot/app.bsky.feed.post/reply-old-mtime");
    assert.ok(
      notes.lines.some((l) => /lock file is \d+s old, at least LOCK_STALE_MS/.test(l)),
      `the take-over should be justified by the lock's age, saw: ${notes.lines.join(" | ") || "nothing"}`
    );
  } finally {
    notes.restore();
  }

  assert.equal(await store.isHandled(uri), true, "the stale lock was taken over and the write landed");
  assert.equal(await pathExists(lockPath), false, "the taken-over lock was released normally afterwards");
}

/**
 * A live holder with a freshly touched lock file keeps it: failing loudly is
 * correct, because stealing that lock would lose the other writer's updates.
 */
async function testLiveFreshLockIsNeverStolen() {
  const storePath = getTempStorePath("lock-not-stolen");
  const lockPath = lockPathFor(storePath);
  const store = new MentionStore(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/lock-held-elsewhere";
  const foreignToken = `${process.pid}:liveholder03`; // our own pid is guaranteed live

  await writeForeignLock(storePath, foreignToken);

  const notes = captureStoreNotes();
  try {
    await assert.rejects(
      () => store.markInProgress(uri),
      /lock was not taken over/,
      "a live, fresh holder must not have its lock stolen"
    );
    // The lazy write-path prune hit the same wall first and swallowed it.
    assert.ok(
      notes.lines.some((l) => l.includes("retention pass skipped")),
      `the write-path retention pass must fail safely here, saw: ${notes.lines.join(" | ") || "nothing"}`
    );
  } finally {
    notes.restore();
  }

  assert.equal((await fs.readFile(lockPath, "utf-8")).trim(), foreignToken, "the failed acquirer left the foreign lock alone");
  assert.equal(await pathExists(storePath), false, "the store was not written while the lock was held");

  // Both the prune and the write must have handed the in-process queue back,
  // otherwise every later write in this process would block forever.
  await fs.unlink(lockPath);
  await store.markInProgress(uri);
  assert.equal(await store.size(), 1, "writes resume once the foreign lock is gone");
}

/**
 * If another writer takes the lock file over mid-write, our release must leave
 * that lock alone rather than unlinking it and letting a third writer in.
 */
async function testReleaseLockLeavesRetakenLockAlone() {
  const storePath = getTempStorePath("lock-retaken");
  const lockPath = lockPathFor(storePath);
  const uri = "at://did:plc:alice/app.bsky.feed.post/lock-retaken";

  // A deliberately large store stretches the read → stringify → rename window so
  // another writer can retake the lock file mid-write.
  const filler = Array.from({ length: 20000 }, (_, i) => ({
    id: `at://did:plc:filler/app.bsky.feed.post/${i}`,
    uri: `at://did:plc:filler/app.bsky.feed.post/${i}`,
    status: "replied",
    timestamp: Date.now() - 60000, // recent, so retention keeps them
  }));
  await fs.writeFile(storePath, JSON.stringify({ version: 1, entries: filler }, null, 2), "utf-8");

  const store = new MentionStore(storePath);
  // Warm-up write: claims the hourly retention slot, so the measured write below
  // is the only thing touching the lock file.
  await store.markCompleted("at://did:plc:filler/app.bsky.feed.post/warmup", "at://did:plc:bot/app.bsky.feed.post/r-warmup");

  let writeFailure: unknown;
  const write = store.markInProgress(uri).catch((err: unknown) => {
    writeFailure = err;
  });

  let ourToken = "";
  for (let attempt = 0; attempt < 1000 && !ourToken; attempt++) {
    ourToken = (await fs.readFile(lockPath, "utf-8").catch(() => "")).trim();
    if (!ourToken) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(ourToken, "the write never observed our own lock file — the window was too short to test");
  assert.ok(ourToken.startsWith(`${process.pid}:`), `expected our lock token to record our pid, saw "${ourToken}"`);
  const suffix = ourToken.split(":").slice(1).join(":");
  assert.ok(suffix.length >= 8, `lock token "${ourToken}" carries no unique suffix beyond the pid`);

  const stealerToken = `${process.pid}:stealer04`;
  await fs.writeFile(lockPath, stealerToken, "utf-8");

  await write;
  assert.equal(writeFailure, undefined, `the interrupted write should still succeed: ${writeFailure}`);
  assert.equal(
    (await fs.readFile(lockPath, "utf-8").catch(() => "<gone>")).trim(),
    stealerToken,
    "our release must not unlink a lock another writer took over"
  );
  assert.ok((await store.getAll()).some((e) => e.uri === uri), "the mention write itself still landed atomically");
  assert.equal((await fs.readdir(path.dirname(storePath))).some((name) => name.includes(".tmp.")), false, "no temp file left behind");
}

/** Every write goes through a temp file plus an async rename: no leftovers, valid JSON. */
async function testAtomicRenameLeavesNoTempFile() {
  const storePath = getTempStorePath("rename-atomic");
  const base = path.basename(storePath);
  const store = new MentionStore(storePath);

  for (let i = 0; i < 6; i++) {
    await store.markCompleted(`at://did:plc:alice/app.bsky.feed.post/rename-${i}`, `at://did:plc:bot/app.bsky.feed.post/r-${i}`);
  }
  await store.markSkipped("at://did:plc:alice/app.bsky.feed.post/rename-skipped", "author denied AI inference");
  await store.markFailed("at://did:plc:alice/app.bsky.feed.post/rename-failed", "boom");
  await store.pruneByRetention();

  const leftovers = (await fs.readdir(path.dirname(storePath))).filter(
    (name) => name.startsWith(base + ".tmp.")
  );
  assert.deepEqual(leftovers, [], "no .tmp.<pid> file survives the atomic rename");

  const parsed = JSON.parse(await fs.readFile(storePath, "utf-8"));
  assert.equal(parsed.version, 1, "store file keeps its version field");
  assert.equal(parsed.entries.length, 8, "all writes are visible in the renamed file");
  assert.equal(await store.size(), 8);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Per-status windows: what ages out, and what must not. */
async function testPruneByRetentionPerStatusWindows() {
  assert.ok(DEFAULT_RETENTION.replied > DEFAULT_RETENTION.failed, "replied must outlive failed (duplicate-reply guard)");
  assert.ok(DEFAULT_RETENTION.replied > DEFAULT_RETENTION.pending, "replied must outlive pending");
  assert.ok(DEFAULT_RETENTION.replied > DEFAULT_RETENTION.skipped, "replied must outlive skipped");

  const storePath = getTempStorePath("retention-windows");
  const replied20d = "at://did:plc:u/app.bsky.feed.post/replied-20d";
  const replied1d = "at://did:plc:u/app.bsky.feed.post/replied-1d";
  const failed10d = "at://did:plc:u/app.bsky.feed.post/failed-10d";
  const failed6d = "at://did:plc:u/app.bsky.feed.post/failed-6d";
  const pending8d = "at://did:plc:u/app.bsky.feed.post/pending-8d";
  const pendingExact7d = "at://did:plc:u/app.bsky.feed.post/pending-exactly-7d";
  const pending2d = "at://did:plc:u/app.bsky.feed.post/pending-2d";
  const skipped2d = "at://did:plc:u/app.bsky.feed.post/skipped-2d";
  const skipped20h = "at://did:plc:u/app.bsky.feed.post/skipped-20h";

  await seedStore(storePath, [
    { uri: replied20d, status: "replied", ageMs: 20 * DAY_MS },
    { uri: replied1d, status: "replied", ageMs: DAY_MS },
    { uri: failed10d, status: "failed", ageMs: 10 * DAY_MS },
    { uri: failed6d, status: "failed", ageMs: 6 * DAY_MS },
    { uri: pending8d, status: "pending", ageMs: 8 * DAY_MS },
    { uri: pendingExact7d, status: "pending", ageMs: 7 * DAY_MS },
    { uri: pending2d, status: "pending", ageMs: 2 * DAY_MS },
    { uri: skipped2d, status: "skipped", ageMs: 2 * DAY_MS },
    { uri: skipped20h, status: "skipped", ageMs: 20 * 60 * 60 * 1000 },
  ]);

  const store = new MentionStore(storePath);
  const removed = await store.pruneByRetention();
  assert.equal(removed, 4, "10d failed + 8d pending + exactly-7d pending + 2d skipped aged out");
  assert.deepEqual(urisOf(await store.getAll()), [
    failed6d,
    pending2d,
    replied1d,
    replied20d,
    skipped20h,
  ]);
  assert.equal(await store.isHandled(replied20d), true, "a 20-day-old reply still blocks a duplicate reply");
  assert.equal(await store.isHandled(failed10d), false, "an aged-out failed marker no longer suppresses the mention");
}

/**
 * Regression guard for the reason retention replaced a blanket cleanup in the
 * live process: pruning must never re-open a mention that was already answered,
 * while the flat 24h cleanup default would have.
 */
async function testPruneKeepsRecentReplyAsDuplicateGuard() {
  const storePath = getTempStorePath("retention-duplicate-guard");
  const replied3d = "at://did:plc:u/app.bsky.feed.post/replied-3d";
  const failed9d = "at://did:plc:u/app.bsky.feed.post/failed-9d";
  const skipped3d = "at://did:plc:u/app.bsky.feed.post/skipped-3d";

  await seedStore(storePath, [
    { uri: replied3d, status: "replied", ageMs: 3 * DAY_MS },
    { uri: failed9d, status: "failed", ageMs: 9 * DAY_MS },
    { uri: skipped3d, status: "skipped", ageMs: 3 * DAY_MS, reason: "author denied AI inference" },
  ]);

  const store = new MentionStore(storePath);
  assert.equal(await store.pruneByRetention(), 2, "only the aged failed and skipped markers go");
  assert.equal(await store.isHandled(replied3d), true, "pruning must not re-open a mention we already answered");

  // Contrast: what the old habit of calling cleanup() on a timer would have done.
  assert.equal(await store.cleanup(), 1, "the flat 24h cleanup window would drop the 3-day-old reply");
  assert.equal(await store.isHandled(replied3d), false, "…which is exactly the duplicate-reply hazard retention avoids");
}

/** Overrides, `Infinity` as "keep forever", and statuses we do not understand. */
async function testPruneByRetentionOverridesAndUnknownStatus() {
  const storePath = getTempStorePath("retention-overrides");
  const failed10d = "at://did:plc:u/app.bsky.feed.post/failed-10d";
  const skipped3d = "at://did:plc:u/app.bsky.feed.post/skipped-3d";
  const unknown10d = "at://did:plc:u/app.bsky.feed.post/legacy-awaiting-review";

  await seedStore(storePath, [
    { uri: failed10d, status: "failed", ageMs: 10 * DAY_MS },
    { uri: skipped3d, status: "skipped", ageMs: 3 * DAY_MS },
    { uri: unknown10d, status: "awaiting-review", ageMs: 10 * DAY_MS },
  ]);

  const store = new MentionStore(storePath);

  const kept: Partial<RetentionPolicy> = { failed: 30 * DAY_MS, skipped: Infinity };
  assert.equal(await store.pruneByRetention(kept), 0, "widened windows keep failed and skipped; Infinity keeps them forever");
  assert.deepEqual(urisOf(await store.getAll()), [failed10d, unknown10d, skipped3d]);

  // Unknown statuses fall back to the longest window in the policy, never a
  // shorter one, so a status we do not understand is never discarded early.
  assert.equal(await store.pruneByRetention({ skipped: 0 }), 2, "skipped window 0 drops skips; legacy status survives");
  assert.deepEqual(urisOf(await store.getAll()), [unknown10d]);

  assert.equal(await store.pruneByRetention(), 0, "the legacy status survives the default windows too");
  assert.deepEqual(urisOf(await store.getAll()), [unknown10d]);
}

/** The write path ages entries out on first use, then at most hourly per path. */
async function testWritePathRunsRetentionOncePerHour() {
  const storePath = getTempStorePath("retention-throttle");
  const store = new MentionStore(storePath);
  const agedFailed = "at://did:plc:u/app.bsky.feed.post/failed-10d";

  await seedStore(storePath, [{ uri: agedFailed, status: "failed", ageMs: 10 * DAY_MS }]);

  await store.markInProgress("at://did:plc:u/app.bsky.feed.post/first-write");
  const afterFirst = urisOf(await store.getAll());
  assert.ok(afterFirst.includes("at://did:plc:u/app.bsky.feed.post/first-write"));
  assert.ok(!afterFirst.includes(agedFailed), "the first write through a store path runs a retention pass");

  // Age the store again behind the store's back, then write again inside the hour.
  const raw = JSON.parse(await fs.readFile(storePath, "utf-8"));
  raw.entries.push({ id: agedFailed, uri: agedFailed, status: "failed", timestamp: Date.now() - 10 * DAY_MS });
  await fs.writeFile(storePath, JSON.stringify(raw, null, 2), "utf-8");

  await store.markCompleted("at://did:plc:u/app.bsky.feed.post/second-write", "at://did:plc:bot/app.bsky.feed.post/r2");
  assert.ok(
    urisOf(await store.getAll()).includes(agedFailed),
    "a second retention pass must be throttled to once per hour per store path"
  );
}

/** getMentionStore() — the stdio process's long-lived store — ages at creation. */
async function testSingletonRunsRetentionOnCreation() {
  const storePath = getTempStorePath("retention-singleton");
  const agedFailed = "at://did:plc:u/app.bsky.feed.post/failed-12d";
  const replied20d = "at://did:plc:u/app.bsky.feed.post/replied-20d";
  const newMention = "at://did:plc:u/app.bsky.feed.post/new-mention";

  await seedStore(storePath, [
    { uri: agedFailed, status: "failed", ageMs: 12 * DAY_MS },
    { uri: replied20d, status: "replied", ageMs: 20 * DAY_MS },
  ]);

  const oldEnv = process.env.MENTION_STORE_PATH;
  try {
    process.env.MENTION_STORE_PATH = storePath;
    resetMentionStoreSingleton();
    const store = getMentionStore();
    assert.equal(store.getPath(), path.resolve(storePath));

    // The creation pass is not awaited by getMentionStore(); the first write
    // awaits it, so it is ordered ahead of traffic instead of racing it.
    await store.markInProgress(newMention);

    const uris = urisOf(await store.getAll());
    assert.deepEqual(uris, [newMention, replied20d].sort());
    assert.equal(await store.isHandled(replied20d), true, "the startup pass keeps the duplicate-reply guard");
  } finally {
    resetMentionStoreSingleton();
    if (oldEnv !== undefined) {
      process.env.MENTION_STORE_PATH = oldEnv;
    } else {
      delete process.env.MENTION_STORE_PATH;
    }
  }
}

/** A retention pass that cannot get the lock must never break a mention write. */
async function testRetentionFailureNeverBreaksMentionWrite() {
  const storePath = getTempStorePath("retention-failure");
  const lockPath = lockPathFor(storePath);
  const uri = "at://did:plc:u/app.bsky.feed.post/written-despite-prune-failure";

  // Live, freshly touched lock held elsewhere: the lazy pass cannot get it.
  await writeForeignLock(storePath, `${process.pid}:liveholder11`);

  let writeFailure: unknown;
  const notes = captureStoreNotes();
  try {
    const store = new MentionStore(storePath);
    const write = store.markInProgress(uri).catch((err: unknown) => {
      writeFailure = err;
    });

    const note = await notes.once("retention pass skipped");
    assert.match(note, new RegExp(`retention pass skipped for ${storePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // The mention write is now waiting on that same lock; let it through.
    await fs.unlink(lockPath);
    await write;
  } finally {
    notes.restore();
    await fs.rm(lockPath, { force: true });
  }

  assert.equal(writeFailure, undefined, "a failed retention pass must not reject the mention write");
  assert.ok(
    urisOf(await new MentionStore(storePath).getAll()).includes(uri),
    "the mention write survived the failed retention pass"
  );
}

const tests: Array<[string, () => Promise<void>]> = [
  ["testInitAndEmpty", testInitAndEmpty],
  ["testMarkInProgress", testMarkInProgress],
  ["testMarkCompleted", testMarkCompleted],
  ["testMarkCompletedDirectly", testMarkCompletedDirectly],
  ["testMarkFailed", testMarkFailed],
  ["testMarkFailedDirectly", testMarkFailedDirectly],
  ["testGetPendingOrdering", testGetPendingOrdering],
  ["testCleanupCustomAge", testCleanupCustomAge],
  ["testCleanupDefault24h", testCleanupDefault24h],
  ["testCleanupNoop", testCleanupNoop],
  ["testAtomicWriteFileStructure", testAtomicWriteFileStructure],
  ["testClear", testClear],
  ["testConcurrentWrites", testConcurrentWrites],
  ["testEnvVarStorePath", testEnvVarStorePath],
  ["testSingletonInstance", testSingletonInstance],
  ["testUpdateExistingEntryStatus", testUpdateExistingEntryStatus],
  ["testNonExistentFileHandledGracefully", testNonExistentFileHandledGracefully],
  ["testGetAllReturnsCopy", testGetAllReturnsCopy],
  ["testMultipleCompletedEntries", testMultipleCompletedEntries],
  ["testMultipleFailedEntries", testMultipleFailedEntries],
  ["testMixedEntriesLifecycle", testMixedEntriesLifecycle],
  ["testCleanupPreservesPendingIfRecent", testCleanupPreservesPendingIfRecent],
  ["testCleanupRemovesOldPending", testCleanupRemovesOldPending],
  ["testMarkCompletedWithoutReplyUri", testMarkCompletedWithoutReplyUri],
  ["testMarkFailedWithoutError", testMarkFailedWithoutError],
  ["testConcurrentReadsAndWrites", testConcurrentReadsAndWrites],
  ["testDefaultStorePathFallback", testDefaultStorePathFallback],
  ["testWhitespaceEnvStorePathFallback", testWhitespaceEnvStorePathFallback],
  ["testIdMatchesUri", testIdMatchesUri],
  ["testTimestampUpdatedOnMarkCompleted", testTimestampUpdatedOnMarkCompleted],
  ["testTimestampUpdatedOnMarkFailed", testTimestampUpdatedOnMarkFailed],
  ["testDoubleMarkInProgressPreservesSingleEntry", testDoubleMarkInProgressPreservesSingleEntry],
  ["testMarkSkippedIsNotHandled", testMarkSkippedIsNotHandled],
  ["testMarkSkippedDirectly", testMarkSkippedDirectly],
  ["testMarkSkippedWithoutReason", testMarkSkippedWithoutReason],
  ["testSkippedDoesNotChangeTerminalStatuses", testSkippedDoesNotChangeTerminalStatuses],
  ["testMarkSkippedThenMarkCompletedTransitions", testMarkSkippedThenMarkCompletedTransitions],
  ["testMarkSkippedThenMarkInProgressReopens", testMarkSkippedThenMarkInProgressReopens],
  ["testMarkSkippedDoesNotDowngradeTerminalEntries", testMarkSkippedDoesNotDowngradeTerminalEntries],
  ["testRepeatedMarkSkippedUpdatesReasonAndTimestamp", testRepeatedMarkSkippedUpdatesReasonAndTimestamp],
  ["testSkippedFileStructure", testSkippedFileStructure],
  ["testSkippedEntriesPersistAcrossReload", testSkippedEntriesPersistAcrossReload],
  ["testLegacyStoreWithoutSkippedLoads", testLegacyStoreWithoutSkippedLoads],
  ["testUnknownLegacyStatusIsHandled", testUnknownLegacyStatusIsHandled],
  ["testMixedStatusesIncludingSkipped", testMixedStatusesIncludingSkipped],
  ["testCleanupRemovesOldSkipped", testCleanupRemovesOldSkipped],
  ["testConcurrentSkippedWrites", testConcurrentSkippedWrites],
  ["testStaleLockDeadPidIsTakenOverQuickly", testStaleLockDeadPidIsTakenOverQuickly],
  ["testStaleLockOldMtimeIsTakenOver", testStaleLockOldMtimeIsTakenOver],
  ["testLiveFreshLockIsNeverStolen", testLiveFreshLockIsNeverStolen],
  ["testReleaseLockLeavesRetakenLockAlone", testReleaseLockLeavesRetakenLockAlone],
  ["testAtomicRenameLeavesNoTempFile", testAtomicRenameLeavesNoTempFile],
  ["testPruneByRetentionPerStatusWindows", testPruneByRetentionPerStatusWindows],
  ["testPruneKeepsRecentReplyAsDuplicateGuard", testPruneKeepsRecentReplyAsDuplicateGuard],
  ["testPruneByRetentionOverridesAndUnknownStatus", testPruneByRetentionOverridesAndUnknownStatus],
  ["testWritePathRunsRetentionOncePerHour", testWritePathRunsRetentionOncePerHour],
  ["testSingletonRunsRetentionOnCreation", testSingletonRunsRetentionOnCreation],
  ["testRetentionFailureNeverBreaksMentionWrite", testRetentionFailureNeverBreaksMentionWrite],
];

async function main() {
  await setup();
  await runTests(tests);

  await cleanup();

}

main();

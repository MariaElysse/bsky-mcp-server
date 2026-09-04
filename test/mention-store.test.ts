#!/usr/bin/env node
/**
 * mention-store.test — unit and integration tests for MentionStore.
 *
 * Covers:
 *  - File creation and format (JSON file with version & entries)
 *  - Atomic writes and data integrity
 *  - isHandled (unhandled, pending, replied, failed)
 *  - markInProgress (creates pending entry, updates timestamp)
 *  - markCompleted (updates to replied, stores replyUri)
 *  - markFailed (updates to failed, stores error message)
 *  - getPending (retrieves pending entries sorted oldest first)
 *  - cleanup (removes entries older than maxAgeMs, default 24h)
 *  - size, getAll, clear, getPath helper methods
 *  - Concurrent access & locking
 *  - Environment variable MENTION_STORE_PATH override
 *  - Singleton getMentionStore() behavior
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MentionStore, getMentionStore } from "../src/mention-store.js";

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
  const s1 = getMentionStore();
  const s2 = getMentionStore();
  assert.strictEqual(s1, s2, "getMentionStore() should return the same singleton instance");
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
// Runner
// ---------------------------------------------------------------------------

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
];

async function main() {
  await setup();
  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
      passed++;
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      failed++;
    }
  }

  await cleanup();

  console.log(`\n${passed} / ${tests.length} test(s) passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();

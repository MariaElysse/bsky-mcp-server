#!/usr/bin/env node
/**
 * mention-monitor.test.ts — Comprehensive integration test suite for
 * `run-mention-monitor` MCP tool.
 *
 * Covers:
 *  (1) Tool registration & MCP schema discoverability
 *  (2) State query when poll=false (pending, replied, failed counts)
 *  (3) Polling with empty notifications list
 *  (4) Polling new mentions with autoReply=false (marked pending in store)
 *  (5) Auto-reply posting for root posts (root/parent CID resolution)
 *  (6) Auto-reply posting for nested posts (root CID from parent reply structure)
 *  (7) Deduplication across multiple runs (skipping already handled mentions)
 *  (8) AI preference filtering (denied users skipped & marked handled)
 *  (9) Post URI format validation (malformed URIs rejected & marked failed)
 *  (10) Reply content validation (max 256 chars, non-empty)
 *  (11) Dedup store persistence across MentionStore instances
 *  (12) Graceful error handling on post creation API failure
 *  (13) Graceful error handling on thread retrieval failure
 *  (14) maxMentions capping (only process requested batch limit)
 *  (15) Graceful error handling on listNotifications failure
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";
import { MentionStore } from "../src/mention-store.js";
import { generateMentionReply, buildMentionReplyPrompt } from "../src/prompts.js";

// ---------------------------------------------------------------------------
// Helpers and Harness
// ---------------------------------------------------------------------------

function makeTempStorePath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsky-mention-monitor-test-"));
  return path.join(tmpDir, "mention-store.json");
}

async function createHarness(provider: AgentProvider) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function makeMockNotification(
  authorDid: string,
  handle: string,
  uri: string,
  cid: string = "cid_mention_123",
  text: string = "Hello @bot please help"
) {
  return {
    uri,
    cid,
    author: {
      did: authorDid,
      handle: handle,
      displayName: handle.toUpperCase(),
    },
    reason: "mention",
    record: {
      text,
      createdAt: new Date().toISOString(),
    },
    isRead: false,
    indexedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

/** (1) Tool registration & MCP schema discoverability */
async function testToolRegistration() {
  const { client, close } = await createHarness(() => null);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "run-mention-monitor");
    assert.ok(tool, "run-mention-monitor should be registered");
    assert.ok(tool.inputSchema, "tool should have inputSchema");
    assert.ok(
      (tool.inputSchema as any).properties?.poll,
      "tool inputSchema should define poll property"
    );
    assert.ok(
      (tool.inputSchema as any).properties?.autoReply,
      "tool inputSchema should define autoReply property"
    );
    assert.ok(
      (tool.inputSchema as any).properties?.maxMentions,
      "tool inputSchema should define maxMentions property"
    );
  } finally {
    await close();
  }
}

/** (2) State query when poll=false */
async function testPollFalseReturnsStoreState() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const store = new MentionStore(storePath);
  await store.markInProgress("at://did:plc:user1/app.bsky.feed.post/1");
  await store.markCompleted("at://did:plc:user2/app.bsky.feed.post/2", "at://did:plc:bot/app.bsky.feed.post/reply2");
  await store.markFailed("at://did:plc:user3/app.bsky.feed.post/3", "Some error");

  const { client, close } = await createHarness(() => null);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: false },
    });

    assert.equal(res.isError, undefined, "Expected success response when poll=false");
    const text = res.content[0].text;
    assert.match(text, /Mention monitor state:/);
    assert.match(text, /Pending:\s*1/);
    assert.match(text, /Replied:\s*1/);
    assert.match(text, /Failed:\s*1/);
  } finally {
    await close();
  }
}

/** (3) Polling with empty notifications list */
async function testEmptyNotifications() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [] },
          }),
        },
      },
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: false },
    });

    assert.equal(res.isError, undefined);
    const text = res.content[0].text;
    assert.match(text, /Scanned 0 notifications/);
    assert.match(text, /Found 0 new mentions/);
    assert.match(text, /0 mention\(s\) replied to automatically/);
    assert.match(text, /0 mention\(s\) skipped/);
    assert.match(text, /0 mention\(s\) failed/);
  } finally {
    await close();
  }
}

/** (4) Polling new mentions with autoReply=false */
async function testNewMentionPollOnly() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const notif = makeMockNotification(
    "did:plc:alice",
    "alice.bsky.social",
    "at://did:plc:alice/app.bsky.feed.post/1001"
  );

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async () => ({ success: false }),
        },
      },
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: false },
    });

    assert.equal(res.isError, undefined);
    const text = res.content[0].text;
    assert.match(text, /Scanned 1 notifications/);
    assert.match(text, /Found 1 new mentions/);
    assert.match(text, /0 mention\(s\) replied to automatically/);

    // Verify stored as pending
    const store = new MentionStore(storePath);
    const pending = await store.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].uri, "at://did:plc:alice/app.bsky.feed.post/1001");
  } finally {
    await close();
  }
}

/** (5) Auto-reply posting for root posts (root/parent CID resolution) */
async function testAutoReplyRootPost() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const mentionUri = "at://did:plc:alice/app.bsky.feed.post/root1";
  const notif = makeMockNotification(
    "did:plc:alice",
    "alice.bsky.social",
    mentionUri,
    "cid_root_123",
    "Hello @bot!"
  );

  let postedRecord: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: {
              thread: {
                $type: "app.bsky.feed.defs#threadViewPost",
                post: {
                  uri: mentionUri,
                  cid: "cid_root_123",
                  author: { did: "did:plc:alice", handle: "alice.bsky.social" },
                  record: { text: "Hello @bot!", createdAt: new Date().toISOString() },
                },
              },
            },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async () => ({ success: false }),
        },
      },
    },
    post: async (record: any) => {
      postedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1", cid: "cid_reply_1" };
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });

    assert.equal(res.isError, undefined);
    const text = res.content[0].text;
    assert.match(text, /1 mention\(s\) replied to automatically/);

    // Verify reply structure
    assert.ok(postedRecord, "Expected post to be called");
    assert.equal(postedRecord.reply.parent.uri, mentionUri);
    assert.equal(postedRecord.reply.parent.cid, "cid_root_123");
    assert.equal(postedRecord.reply.root.uri, mentionUri);
    assert.equal(postedRecord.reply.root.cid, "cid_root_123");
    assert.match(postedRecord.text, /@alice\.bsky\.social/);

    // Verify mention-store recorded completion
    const store = new MentionStore(storePath);
    const all = await store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "replied");
    assert.equal(all[0].replyUri, "at://did:plc:bot/app.bsky.feed.post/reply1");
  } finally {
    await close();
  }
}

/** (6) Auto-reply posting for nested posts (root CID from parent reply structure) */
async function testAutoReplyNestedPost() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const rootUri = "at://did:plc:charlie/app.bsky.feed.post/root99";
  const rootCid = "cid_root_99";
  const nestedUri = "at://did:plc:bob/app.bsky.feed.post/nested2";
  const nestedCid = "cid_nested_2";

  const notif = makeMockNotification(
    "did:plc:bob",
    "bob.bsky.social",
    nestedUri,
    nestedCid,
    "Help @bot in this thread"
  );

  let postedRecord: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: {
              thread: {
                $type: "app.bsky.feed.defs#threadViewPost",
                post: {
                  uri: nestedUri,
                  cid: nestedCid,
                  author: { did: "did:plc:bob", handle: "bob.bsky.social" },
                  record: {
                    text: "Help @bot in this thread",
                    createdAt: new Date().toISOString(),
                    reply: {
                      root: { uri: rootUri, cid: rootCid },
                      parent: { uri: rootUri, cid: rootCid },
                    },
                  },
                },
              },
            },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async () => ({ success: false }),
        },
      },
    },
    post: async (record: any) => {
      postedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply2", cid: "cid_reply_2" };
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });

    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /1 mention\(s\) replied to automatically/);

    // Parent should be the nested post, root should be the original thread root
    assert.ok(postedRecord);
    assert.equal(postedRecord.reply.parent.uri, nestedUri);
    assert.equal(postedRecord.reply.parent.cid, nestedCid);
    assert.equal(postedRecord.reply.root.uri, rootUri);
    assert.equal(postedRecord.reply.root.cid, rootCid);
  } finally {
    await close();
  }
}

/** (7) Deduplication across multiple runs */
async function testNotificationDeduplicationAcrossRuns() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const mentionUri = "at://did:plc:alice/app.bsky.feed.post/dedup1";
  const notif = makeMockNotification("did:plc:alice", "alice.bsky.social", mentionUri);

  let postCount = 0;
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: {
              thread: {
                $type: "app.bsky.feed.defs#threadViewPost",
                post: {
                  uri: mentionUri,
                  cid: "cid_1",
                  author: { did: "did:plc:alice", handle: "alice.bsky.social" },
                  record: { text: "Hello", createdAt: new Date().toISOString() },
                },
              },
            },
          }),
        },
      },
    },
    com: {
      atproto: { repo: { getRecord: async () => ({ success: false }) } },
    },
    post: async () => {
      postCount++;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/rep", cid: "cid_rep" };
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    // Run 1: Should reply
    const res1: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });
    assert.match(res1.content[0].text, /1 mention\(s\) replied to automatically/);
    assert.equal(postCount, 1);

    // Run 2: Should skip
    const res2: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });
    assert.match(res2.content[0].text, /1 mention\(s\) skipped/);
    assert.match(res2.content[0].text, /0 mention\(s\) replied to automatically/);
    assert.equal(postCount, 1, "post should not be called again");
  } finally {
    await close();
  }
}

/** (8) AI preference filtering */
async function testAiPreferenceFilteringDenied() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const mentionUri = "at://did:plc:denieduser/app.bsky.feed.post/secret1";
  const notif = makeMockNotification("did:plc:denieduser", "denied.bsky.social", mentionUri);

  let postCalled = false;
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async (req: any) => {
            if (req.repo === "did:plc:denieduser") {
              return {
                success: true,
                data: {
                  value: {
                    preferences: {
                      inference: { allow: false },
                      training: { allow: false },
                    },
                  },
                },
              };
            }
            return { success: false };
          },
        },
      },
    },
    post: async () => {
      postCalled = true;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/r", cid: "cid_r" };
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });

    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /1 mention\(s\) skipped \(already handled \/ AI preference denied\)/);
    assert.match(res.content[0].text, /0 mention\(s\) replied to automatically/);
    assert.equal(postCalled, false, "post should not be called for AI denied user");

    // Store should mark it failed so it is considered handled
    const store = new MentionStore(storePath);
    assert.equal(await store.isHandled(mentionUri), true);
  } finally {
    await close();
  }
}

/** (9) Post URI format validation */
async function testInvalidPostUriFormat() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const notif = makeMockNotification(
    "did:plc:alice",
    "alice.bsky.social",
    "invalid-uri-scheme://malformed"
  );

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
      },
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });

    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /1 mention\(s\) failed with errors/);
  } finally {
    await close();
  }
}

/** (10) Reply content validation (max 256 chars, non-empty) */
async function testReplyContentValidation() {
  const longReply = generateMentionReply("verylongauthorhandle", "a".repeat(400));
  assert.ok(longReply.length <= 256, `Reply length must be <= 256, got ${longReply.length}`);
  assert.ok(longReply.trim().length > 0, "Reply must not be empty");

  const emptyReply = generateMentionReply("", "");
  assert.ok(emptyReply.trim().length > 0, "Default reply must not be empty even for empty input");
}

/** (11) Dedup store persistence across MentionStore instances */
async function testDedupStorePersistence() {
  const storePath = makeTempStorePath();
  const store1 = new MentionStore(storePath);
  await store1.markCompleted("at://did:plc:alice/app.bsky.feed.post/persist1", "at://did:plc:bot/post/1");

  const store2 = new MentionStore(storePath);
  const isHandled = await store2.isHandled("at://did:plc:alice/app.bsky.feed.post/persist1");
  assert.equal(isHandled, true, "Entry written by instance 1 should be visible to instance 2");
}

/** (12) Graceful error handling on post creation failure */
async function testGracefulErrorHandlingOnPostFailure() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const notif1 = makeMockNotification("did:plc:alice", "alice.test", "at://did:plc:alice/app.bsky.feed.post/fail1");
  const notif2 = makeMockNotification("did:plc:bob", "bob.test", "at://did:plc:bob/app.bsky.feed.post/ok2");

  let postCallCount = 0;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif1, notif2] },
          }),
        },
        feed: {
          getPostThread: async (req: any) => ({
            success: true,
            data: {
              thread: {
                $type: "app.bsky.feed.defs#threadViewPost",
                post: {
                  uri: req.uri,
                  cid: "cid_test",
                  author: { did: "did:plc:test", handle: "test.bsky.social" },
                  record: { text: "hello", createdAt: new Date().toISOString() },
                },
              },
            },
          }),
        },
      },
    },
    com: {
      atproto: { repo: { getRecord: async () => ({ success: false }) } },
    },
    post: async (record: any) => {
      postCallCount++;
      if (record.reply.parent.uri.includes("fail1")) {
        throw new Error("Network timeout during post creation");
      }
      return { uri: "at://did:plc:bot/app.bsky.feed.post/success", cid: "cid_succ" };
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });

    assert.equal(res.isError, undefined);
    const text = res.content[0].text;
    assert.match(text, /Scanned 2 notifications/);
    assert.match(text, /1 mention\(s\) replied to automatically/);
    assert.match(text, /1 mention\(s\) failed with errors/);
    assert.equal(postCallCount, 2, "Both notifications should have been attempted");
  } finally {
    await close();
  }
}

/** (13) Graceful error handling on thread retrieval failure */
async function testGracefulErrorHandlingOnGetPostThreadFailure() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const notif = makeMockNotification(
    "did:plc:alice",
    "alice.test",
    "at://did:plc:alice/app.bsky.feed.post/threadfail"
  );

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: [notif] },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: false,
          }),
        },
      },
    },
    com: {
      atproto: { repo: { getRecord: async () => ({ success: false }) } },
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: true },
    });

    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /1 mention\(s\) failed with errors/);
  } finally {
    await close();
  }
}

/** (14) maxMentions capping */
async function testMaxMentionsLimit() {
  const storePath = makeTempStorePath();
  process.env.MENTION_STORE_PATH = storePath;

  const notifs = [
    makeMockNotification("did:plc:u1", "u1.test", "at://did:plc:u1/app.bsky.feed.post/1"),
    makeMockNotification("did:plc:u2", "u2.test", "at://did:plc:u2/app.bsky.feed.post/2"),
    makeMockNotification("did:plc:u3", "u3.test", "at://did:plc:u3/app.bsky.feed.post/3"),
  ];

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: { notifications: notifs },
          }),
        },
      },
    },
    com: {
      atproto: { repo: { getRecord: async () => ({ success: false }) } },
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true, autoReply: false, maxMentions: 2 },
    });

    assert.equal(res.isError, undefined);
    const text = res.content[0].text;
    assert.match(text, /Scanned 2 notifications/);
    assert.match(text, /Found 2 new mentions/);
  } finally {
    await close();
  }
}

/** (15) Graceful error handling on listNotifications failure */
async function testListNotificationsFailure() {
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        notification: {
          listNotifications: async () => {
            throw new Error("Rate limit exceeded: 429 Too Many Requests");
          },
        },
      },
    },
  };

  const { client, close } = await createHarness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "run-mention-monitor",
      arguments: { poll: true },
    });

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Rate limit exceeded/);
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------

async function main() {
  const tests: Array<[string, () => Promise<void>]> = [
    ["testToolRegistration", testToolRegistration],
    ["testPollFalseReturnsStoreState", testPollFalseReturnsStoreState],
    ["testEmptyNotifications", testEmptyNotifications],
    ["testNewMentionPollOnly", testNewMentionPollOnly],
    ["testAutoReplyRootPost", testAutoReplyRootPost],
    ["testAutoReplyNestedPost", testAutoReplyNestedPost],
    ["testNotificationDeduplicationAcrossRuns", testNotificationDeduplicationAcrossRuns],
    ["testAiPreferenceFilteringDenied", testAiPreferenceFilteringDenied],
    ["testInvalidPostUriFormat", testInvalidPostUriFormat],
    ["testReplyContentValidation", testReplyContentValidation],
    ["testDedupStorePersistence", testDedupStorePersistence],
    ["testGracefulErrorHandlingOnPostFailure", testGracefulErrorHandlingOnPostFailure],
    ["testGracefulErrorHandlingOnGetPostThreadFailure", testGracefulErrorHandlingOnGetPostThreadFailure],
    ["testMaxMentionsLimit", testMaxMentionsLimit],
    ["testListNotificationsFailure", testListNotificationsFailure],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
      passed++;
    } catch (err) {
      console.error(`not ok - ${name}`);
      console.error(err);
      failed++;
    }
  }

  console.log(`\n${passed} / ${tests.length} test(s) passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();

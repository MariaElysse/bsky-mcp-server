#!/usr/bin/env node
/**
 * mention-context.test — unit and integration tests for get-mention-context MCP tool.
 *
 * Requirements:
 * 1. Tool registration (appears in tool list)
 * 2. Fetches mention notifications correctly
 * 3. Builds thread context from fetched mentions
 * 4. AI preference filtering removes denied posts
 * 5. Deduplication skips already-handled mentions
 * 6. Error handling for API failures
 * 7. Empty notification handling
 * 8. Invalid URI format handling
 * 9. Limit parameter respected (max 50)
 * 10. Multiple mentions formatted correctly
 * 11. Edge case: mention from user who denied inference/training
 * + Additional edge cases and thread-context module tests.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";
import { MentionStore, getMentionStore } from "../src/mention-store.js";
import {
  extractAllParticipants,
  formatThreadForReply,
  isolateBranch,
  formatPermissionSummary,
  fetchThreadContext,
} from "../src/thread-context.js";

const TEST_DIR = path.join(
  os.tmpdir(),
  "bsky-mcp-mention-context-test-" + Date.now() + "-" + Math.random().toString(36).slice(2)
);

let testStorePath: string;

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true });
  testStorePath = path.join(TEST_DIR, "test-mention-store.json");
  process.env.MENTION_STORE_PATH = testStorePath;
}

async function cleanup() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers to create mock thread and post objects
// ---------------------------------------------------------------------------

function createMockPost(did: string, handle: string, text: string, uri: string, replyTo?: any) {
  return {
    uri,
    cid: "cid_" + uri,
    author: {
      did,
      handle,
      displayName: handle.toUpperCase(),
    },
    record: {
      text,
      createdAt: "2026-08-30T12:00:00.000Z",
      reply: replyTo ? { root: replyTo.root, parent: replyTo.parent } : undefined,
    },
    indexedAt: "2026-08-30T12:00:00.000Z",
  };
}

function createMockThreadView(post: any, parent?: any, replies: any[] = []) {
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post,
    parent,
    replies,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** 1. Tool registration */
async function testToolRegistration() {
  const { client, close } = await harness(() => null);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get-mention-context");
    assert.ok(tool, "get-mention-context tool should be registered");
    assert.ok(tool.description?.includes("mention"), "tool description should mention mentions");
    assert.ok(tool.inputSchema?.properties?.limit, "tool inputSchema should have limit property");
  } finally {
    await close();
  }
}

/** Unauthenticated check */
async function testUnauthenticatedError() {
  const { client, close } = await harness(() => null);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Not connected to Bluesky/);
  } finally {
    await close();
  }
}

/** 2. Fetches mention notifications correctly */
async function testFetchesMentionNotifications() {
  let capturedArgs: any = null;

  const mockNotifUri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const mockPost = createMockPost("did:plc:alice", "alice.test", "Hello @bot check this out", mockNotifUri);
  const mockThread = createMockThreadView(mockPost);

  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async (args: any) => {
            capturedArgs = args;
            return {
              success: true,
              data: {
                notifications: [
                  {
                    uri: mockNotifUri,
                    author: { did: "did:plc:alice", handle: "alice.test" },
                    record: { text: "Hello @bot check this out", createdAt: "2026-08-30T12:00:00.000Z" },
                    indexedAt: "2026-08-30T12:00:00.000Z",
                    reason: "mention",
                  },
                ],
              },
            };
          },
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: mockThread },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async () => ({ success: false }), // default allow
        },
      },
    },
  };

  const store = getMentionStore();
  await store.clear();

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: { limit: 15 },
    });
    assert.equal(res.isError, undefined);
    assert.deepEqual(capturedArgs, { limit: 15, reasons: ["mention"] });
    assert.match(res.content[0].text, /Retrieved 1 mention\(s\):/);
    assert.match(res.content[0].text, /@alice\.test mentioned you/);
    assert.match(res.content[0].text, /Post: "Hello @bot check this out"/);
    assert.match(res.content[0].text, /Status: visible/);
  } finally {
    await close();
  }
}

/** 3. Builds thread context from fetched mentions */
async function testBuildsThreadContext() {
  const rootUri = "at://did:plc:bob/app.bsky.feed.post/root1";
  const replyUri = "at://did:plc:alice/app.bsky.feed.post/reply1";

  const rootPost = createMockPost("did:plc:bob", "bob.test", "Root discussion topic", rootUri);
  const rootThread = createMockThreadView(rootPost);

  const replyPost = createMockPost(
    "did:plc:alice",
    "alice.test",
    "Replying to bob and pinging @bot",
    replyUri,
    { root: { uri: rootUri, cid: "c1" }, parent: { uri: rootUri, cid: "c1" } }
  );
  const replyThread = createMockThreadView(replyPost, rootThread);

  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri: replyUri,
                  author: { did: "did:plc:alice", handle: "alice.test" },
                  record: {
                    text: "Replying to bob and pinging @bot",
                    reply: { root: { uri: rootUri }, parent: { uri: rootUri } },
                    createdAt: "2026-08-30T12:00:00.000Z",
                  },
                  indexedAt: "2026-08-30T12:00:00.000Z",
                  reason: "mention",
                },
              ],
            },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: replyThread },
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

  const store = getMentionStore();
  await store.clear();

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /@alice\.test mentioned you in a reply to "Root discussion topic"/);
    assert.match(res.content[0].text, /<posts>/);
    assert.match(res.content[0].text, /bob\.test/);
    assert.match(res.content[0].text, /alice\.test/);
  } finally {
    await close();
  }
}

/** 4. AI preference filtering removes / tombstones denied posts */
async function testAiPreferenceFiltering() {
  const rootUri = "at://did:plc:bob/app.bsky.feed.post/root1";
  const replyUri = "at://did:plc:alice/app.bsky.feed.post/reply1";

  const rootPost = createMockPost("did:plc:bob", "bob.test", "Secret root post", rootUri);
  const rootThread = createMockThreadView(rootPost);

  const replyPost = createMockPost("did:plc:alice", "alice.test", "Mentioning @bot", replyUri);
  const replyThread = createMockThreadView(replyPost, rootThread);

  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri: replyUri,
                  author: { did: "did:plc:alice", handle: "alice.test" },
                  record: {
                    text: "Mentioning @bot",
                    createdAt: "2026-08-30T12:00:00.000Z",
                  },
                  indexedAt: "2026-08-30T12:00:00.000Z",
                },
              ],
            },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: replyThread },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async ({ repo }: { repo: string }) => {
            if (repo === "did:plc:bob") {
              // Bob opted out of inference
              return {
                success: true,
                data: {
                  value: {
                    preferences: {
                      inference: { allow: false },
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
  };

  const store = getMentionStore();
  await store.clear();

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    // Thread XML should contain excluded_post tombstone for bob
    assert.match(res.content[0].text, /<excluded_post/);
    assert.equal(res.content[0].text.includes("Secret root post"), false, "Bob's private text should not be visible");
  } finally {
    await close();
  }
}

/** 5. Deduplication skips already-handled mentions */
async function testDeduplicationSkipsHandled() {
  const uriHandled = "at://did:plc:alice/app.bsky.feed.post/already-done";
  const uriNew = "at://did:plc:carol/app.bsky.feed.post/fresh-mention";

  const postNew = createMockPost("did:plc:carol", "carol.test", "Fresh post for @bot", uriNew);
  const threadNew = createMockThreadView(postNew);

  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri: uriHandled,
                  author: { did: "did:plc:alice", handle: "alice.test" },
                  record: { text: "Old post", createdAt: "2026-08-30T10:00:00.000Z" },
                  indexedAt: "2026-08-30T10:00:00.000Z",
                },
                {
                  uri: uriNew,
                  author: { did: "did:plc:carol", handle: "carol.test" },
                  record: { text: "Fresh post for @bot", createdAt: "2026-08-30T12:00:00.000Z" },
                  indexedAt: "2026-08-30T12:00:00.000Z",
                },
              ],
            },
          }),
        },
        feed: {
          getPostThread: async ({ uri }: { uri: string }) => ({
            success: true,
            data: { thread: threadNew },
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

  const store = getMentionStore();
  await store.clear();
  // Mark uriHandled as already replied
  await store.markCompleted(uriHandled, "at://did:plc:bot/app.bsky.feed.post/reply");

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /Retrieved 1 mention\(s\):/);
    assert.match(res.content[0].text, /@carol\.test/);
    assert.equal(res.content[0].text.includes("alice.test"), false, "Handled mention should be skipped");
  } finally {
    await close();
  }
}

/** 6. Error handling for API failures */
async function testApiFailureErrorHandling() {
  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => {
            throw new Error("Rate limit exceeded on notifications endpoint");
          },
        },
      },
    },
  };

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error fetching mentions: Rate limit exceeded on notifications endpoint/);
  } finally {
    await close();
  }
}

/** 7. Empty notification handling */
async function testEmptyNotifications() {
  const fakeAgent: any = {
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

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text.trim(), "No recent mentions found.");
  } finally {
    await close();
  }
}

/** 8. Invalid URI format handling */
async function testInvalidUriFormatHandling() {
  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri: "not-a-valid-at-uri",
                  author: { did: "did:plc:mallory", handle: "mallory.test" },
                  record: { text: "malformed", createdAt: "2026-08-30T12:00:00.000Z" },
                },
              ],
            },
          }),
        },
      },
    },
  };

  const store = getMentionStore();
  await store.clear();

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Invalid post URI format in notification/);
  } finally {
    await close();
  }
}

/** 9. Limit parameter respected (max 50) */
async function testLimitParameterRespected() {
  let requestedLimit = 0;
  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async ({ limit }: { limit: number }) => {
            requestedLimit = limit;
            return {
              success: true,
              data: { notifications: [] },
            };
          },
        },
      },
    },
  };

  const { client, close } = await harness(() => fakeAgent);
  try {
    // Test custom limit
    await client.callTool({
      name: "get-mention-context",
      arguments: { limit: 50 },
    });
    assert.equal(requestedLimit, 50);

    // Test default limit (10)
    await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(requestedLimit, 10);

    // Test schema validation rejects > 50
    const overLimitRes: any = await client.callTool({
      name: "get-mention-context",
      arguments: { limit: 51 },
    });
    assert.equal(overLimitRes.isError, true);
  } finally {
    await close();
  }
}

/** 10. Multiple mentions formatted correctly */
async function testMultipleMentionsFormatted() {
  const uri1 = "at://did:plc:user1/app.bsky.feed.post/p1";
  const uri2 = "at://did:plc:user2/app.bsky.feed.post/p2";

  const post1 = createMockPost("did:plc:user1", "user1.test", "First mention text", uri1);
  const thread1 = createMockThreadView(post1);

  const post2 = createMockPost("did:plc:user2", "user2.test", "Second mention text", uri2);
  const thread2 = createMockThreadView(post2);

  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri: uri1,
                  author: { did: "did:plc:user1", handle: "user1.test" },
                  record: { text: "First mention text", createdAt: "2026-08-30T12:01:00.000Z" },
                  indexedAt: "2026-08-30T12:01:00.000Z",
                },
                {
                  uri: uri2,
                  author: { did: "did:plc:user2", handle: "user2.test" },
                  record: { text: "Second mention text", createdAt: "2026-08-30T12:02:00.000Z" },
                  indexedAt: "2026-08-30T12:02:00.000Z",
                },
              ],
            },
          }),
        },
        feed: {
          getPostThread: async ({ uri }: { uri: string }) => ({
            success: true,
            data: { thread: uri === uri1 ? thread1 : thread2 },
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

  const store = getMentionStore();
  await store.clear();

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /Retrieved 2 mention\(s\):/);
    assert.match(res.content[0].text, /1\. @user1\.test mentioned you/);
    assert.match(res.content[0].text, /Post: "First mention text"/);
    assert.match(res.content[0].text, /2\. @user2\.test mentioned you/);
    assert.match(res.content[0].text, /Post: "Second mention text"/);
  } finally {
    await close();
  }
}

/** 11. Edge case: mention from user who denied inference/training */
async function testMentionFromUserWhoDeniedAi() {
  const uri = "at://did:plc:denieduser/app.bsky.feed.post/denied1";
  const post = createMockPost("did:plc:denieduser", "denied.test", "Do not train on this", uri);
  const thread = createMockThreadView(post);

  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri,
                  author: { did: "did:plc:denieduser", handle: "denied.test" },
                  record: { text: "Do not train on this", createdAt: "2026-08-30T12:00:00.000Z" },
                  indexedAt: "2026-08-30T12:00:00.000Z",
                },
              ],
            },
          }),
        },
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread },
          }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          getRecord: async ({ repo }: { repo: string }) => {
            if (repo === "did:plc:denieduser") {
              return {
                success: true,
                data: {
                  value: {
                    preferences: {
                      training: { allow: false },
                      inference: { allow: false },
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
  };

  const store = getMentionStore();
  await store.clear();

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /Status: excluded_by_ai_prefs/);
    assert.match(res.content[0].text, /Post: "\[Post excluded by author AI preferences\]"/);
    assert.equal(res.content[0].text.includes("Do not train on this"), false, "Private text from opted-out user must not appear");
  } finally {
    await close();
  }
}

/** 12. All notifications handled returns "No recent mentions found." */
async function testAllNotificationsHandled() {
  const uri = "at://did:plc:user1/app.bsky.feed.post/already-replied";
  const fakeAgent: any = {
    app: {
      bsky: {
        notification: {
          listNotifications: async () => ({
            success: true,
            data: {
              notifications: [
                {
                  uri,
                  author: { did: "did:plc:user1", handle: "user1.test" },
                  record: { text: "done", createdAt: "2026-08-30T12:00:00.000Z" },
                },
              ],
            },
          }),
        },
      },
    },
  };

  const store = getMentionStore();
  await store.clear();
  await store.markCompleted(uri, "at://bot/reply");

  const { client, close } = await harness(() => fakeAgent);
  try {
    const res: any = await client.callTool({
      name: "get-mention-context",
      arguments: {},
    });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text.trim(), "No recent mentions found.");
  } finally {
    await close();
  }
}

/** 13. Unit tests for thread-context module functions */
async function testThreadContextHelpers() {
  const p1 = createMockPost("did:plc:1", "u1", "Root", "at://1");
  const p2 = createMockPost("did:plc:2", "u2", "Reply", "at://2");
  const p3 = createMockPost("did:plc:3", "u3", "Nested reply", "at://3");

  const t3 = createMockThreadView(p3);
  const t2 = createMockThreadView(p2, undefined, [t3]);
  const t1 = createMockThreadView(p1, undefined, [t2]);

  // extractAllParticipants
  const participants = extractAllParticipants(t1);
  assert.equal(participants.length, 3);
  assert.ok(participants.includes("did:plc:1"));
  assert.ok(participants.includes("did:plc:2"));
  assert.ok(participants.includes("did:plc:3"));

  // isolateBranch
  const isolated = isolateBranch(t1, "at://3");
  assert.ok(isolated);
  assert.equal(isolated.post.uri, "at://3");

  const missing = isolateBranch(t1, "at://nonexistent");
  assert.equal(missing, null);

  // formatPermissionSummary
  const allowedMap = new Map([
    ["did:plc:1", true],
    ["did:plc:2", false],
  ]);
  const summary = formatPermissionSummary(allowedMap);
  assert.match(summary, /Allowed: 1 participant\(s\)/);
  assert.match(summary, /Denied: 1 participant\(s\)/);
  assert.match(summary, /did:plc:2/);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: Array<[string, () => Promise<void>]> = [
  ["testToolRegistration", testToolRegistration],
  ["testUnauthenticatedError", testUnauthenticatedError],
  ["testFetchesMentionNotifications", testFetchesMentionNotifications],
  ["testBuildsThreadContext", testBuildsThreadContext],
  ["testAiPreferenceFiltering", testAiPreferenceFiltering],
  ["testDeduplicationSkipsHandled", testDeduplicationSkipsHandled],
  ["testApiFailureErrorHandling", testApiFailureErrorHandling],
  ["testEmptyNotifications", testEmptyNotifications],
  ["testInvalidUriFormatHandling", testInvalidUriFormatHandling],
  ["testLimitParameterRespected", testLimitParameterRespected],
  ["testMultipleMentionsFormatted", testMultipleMentionsFormatted],
  ["testMentionFromUserWhoDeniedAi", testMentionFromUserWhoDeniedAi],
  ["testAllNotificationsHandled", testAllNotificationsHandled],
  ["testThreadContextHelpers", testThreadContextHelpers],
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

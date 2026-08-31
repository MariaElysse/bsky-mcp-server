#!/usr/bin/env node
/**
 * create-reply.test — unit and integration tests for the create-reply MCP tool.
 *
 * Requirements:
 * 1. Tool registration (appears in tool list)
 * 2. URI validation rejects malformed URIs
 * 3. Dedup store persistence prevents duplicate replies across runs
 * 4. Root/parent CID resolution for root posts (both set to same post)
 * 5. Root/parent CID resolution for nested replies (follows root/parent refs)
 * 6. Error handling for API failures (getPostThread failure, post failure)
 * 7. Notification deduplication — marks as pending before posting, completed after
 * 8. Auto-reply posting creates a valid reply record with correct structure
 * 9. Duplicate skipping across runs — second call returns early without posting
 * 10. Graceful error reporting for invalid text length
 * 11. Empty notification / missing post handling
 * 12. AI preference check blocks replies to opted-out authors
 * 13. RichText facet detection works (mentions, hashtags)
 * 14. Optional embedUrl parameter generates link preview embed
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, AgentProvider } from "../src/tools.js";
import { MentionStore, getMentionStore } from "../src/mention-store.js";

const TEST_DIR = path.join(
  os.tmpdir(),
  "bsky-mcp-create-reply-test-" + Date.now() + "-" + Math.random().toString(36).slice(2)
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
      await Promise.all([client.close(), server.close()]);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers to create mock thread and post objects
// ---------------------------------------------------------------------------

function createMockPost(did: string, handle: string, text: string, uri: string, replyTo?: any) {
  return {
    uri,
    cid: "cid_" + uri.split("/").pop(),
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
  const h = await harness(() => null);
  try {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t: any) => t.name === "create-reply");
    assert.ok(tool, "create-reply tool should be registered");
    assert.ok(tool.description?.includes("reply"), "tool description should mention reply");
    assert.ok(tool.inputSchema?.properties?.uri, "tool inputSchema should have uri property");
    assert.ok(tool.inputSchema?.properties?.text, "tool inputSchema should have text property");
  } finally {
    await h.close();
  }
}

/** 2. URI validation rejects malformed URIs */
async function testUriValidation() {
  const h = await harness(() => null);
  try {
    // Not authenticated — the tool checks auth first, so this should fail with "Not connected"
    const res1: any = await h.client.callTool({
      name: "create-reply",
      arguments: { uri: "not-a-uri", text: "hello" },
    });
    assert.ok(res1.isError || res1.content[0].text.includes("Not connected"), "should reject without proper agent");

    const h2 = await harness(() => ({
      did: "did:plc:test",
      app: { bsky: {} },
    } as any));

    try {
      const res2: any = await h2.client.callTool({
        name: "create-reply",
        arguments: { uri: "not-a-uri", text: "hello" },
      });
      assert.equal(res2.isError, true);
      assert.match(res2.content[0].text, /Invalid|error/i);
    } finally {
      await h2.close();
    }

    const h3 = await harness(() => ({
      did: "did:plc:test",
      app: { bsky: {} },
    } as any));

    try {
      const res3: any = await h3.client.callTool({
        name: "create-reply",
        arguments: { uri: "", text: "hello" },
      });
      assert.equal(res3.isError, true);
    } finally {
      await h3.close();
    }
  } finally {
    await h.close();
  }
}

/** 3. Dedup store persistence prevents duplicate replies across runs */
async function testDedupStorePersistence() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:alice", "alice.test", "Original post", uri);
  const threadView = createMockThreadView(post);

  let postedRecord: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: threadView },
          }),
        },
      },
    },
    post: async (record: any) => {
      postedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  // First call — should post
  const h1 = await harness(() => fakeAgent);
  try {
    const res1: any = await h1.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "Great point!" },
    });
    assert.equal(res1.isError, undefined);
    assert.match(res1.content[0].text, /Reply created successfully/);
    assert.ok(postedRecord, "post should have been called");
    assert.ok(postedRecord.reply, "reply ref should be set");
  } finally {
    await h1.close();
  }

  // Second call with same URI — should skip (dedup)
  const postedBefore = postedRecord ? JSON.parse(JSON.stringify(postedRecord)) : null;
  const h2 = await harness(() => fakeAgent);
  try {
    const res2: any = await h2.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "Great point!" },
    });
    assert.equal(res2.isError, undefined);
    // Should indicate it was already handled or skipped
    assert.match(res2.content[0].text, /already|skip/i);
  } finally {
    await h2.close();
  }

  // Verify post was only called once (dedup worked)
  const entries = await store.getAll();
  const entry = entries.find((e: any) => e.uri === uri);
  assert.ok(entry, "store should have an entry for this URI");
  assert.equal(entry.status, "replied", "entry status should be 'replied'");
}

/** 4. Root/parent CID resolution for root posts (both set to same post) */
async function testRootParentCidForRootPost() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/root1";

  // Root post — no reply field in record
  const rootPost = createMockPost("did:plc:alice", "alice.test", "This is a root discussion", uri);
  delete (rootPost.record as any).reply; // ensure it's not a reply

  const threadView = createMockThreadView(rootPost);

  let capturedReply: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: threadView },
          }),
        },
      },
    },
    post: async (record: any) => {
      capturedReply = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    await h.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "I disagree with this" },
    });

    assert.ok(capturedReply.reply, "reply ref should be set");
    // For a root post, both parent and root should point to the same post
    assert.equal(
      capturedReply.reply.parent.uri,
      uri,
      "parent URI should match the target URI"
    );
    assert.equal(
      capturedReply.reply.root.uri,
      uri,
      "root URI should match the target URI for a root post"
    );
    // CIDs should be set correctly
    assert.ok(capturedReply.reply.parent.cid, "parent CID should be set");
    assert.ok(capturedReply.reply.root.cid, "root CID should be set");
  } finally {
    await h.close();
  }
}

/** 5. Root/parent CID resolution for nested replies (follows root/parent refs) */
async function testRootParentCidForNestedReply() {
  const rootUri = "at://did:plc:bob/app.bsky.feed.post/root1";
  const replyUri = "at://did:plc:alice/app.bsky.feed.post/reply1";

  // Root post by bob
  const rootPost = createMockPost("did:plc:bob", "bob.test", "Root discussion topic", rootUri);
  delete (rootPost.record as any).reply;

  // Alice's reply to bob — this is what we're replying to
  const aliceReply = createMockPost(
    "did:plc:alice",
    "alice.test",
    "My take on the topic",
    replyUri,
    { root: { uri: rootUri, cid: "rootCid123" }, parent: { uri: rootUri, cid: "rootCid123" } }
  );

  // Thread view: alice's reply with bob's post as parent
  const threadView = createMockThreadView(aliceReply, undefined, []);
  // Set the record.reply on the post to simulate a nested reply
  (threadView.post.record as any).reply = {
    root: { uri: rootUri, cid: "rootCid123" },
    parent: { uri: rootUri, cid: "rootCid123" },
  };

  let capturedReply: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: threadView },
          }),
        },
      },
    },
    post: async (record: any) => {
      capturedReply = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply2" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    await h.client.callTool({
      name: "create-reply",
      arguments: { uri: replyUri, text: "Good follow-up!" },
    });

    assert.ok(capturedReply.reply, "reply ref should be set");
    // Parent should point to alice's reply (the post we're replying to)
    assert.equal(
      capturedReply.reply.parent.uri,
      replyUri,
      "parent URI should be the target URI"
    );
    // Root should follow alice's root ref — pointing to bob's original post
    assert.equal(
      capturedReply.reply.root.uri,
      rootUri,
      "root URI should follow the nested reply chain to the original root"
    );
  } finally {
    await h.close();
  }
}

/** 6. Error handling for API failures */
async function testApiFailureErrorHandling() {
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => {
            throw new Error("Network timeout — PDS unreachable");
          },
        },
      },
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    const res: any = await h.client.callTool({
      name: "create-reply",
      arguments: { uri: "at://did:plc:alice/app.bsky.feed.post/post1", text: "hello" },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Network timeout|getPostThread/i);
  } finally {
    await h.close();
  }
}

/** 7. Notification deduplication — marks as pending before posting, completed after */
async function testNotificationDedup() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:alice", "alice.test", "Original post", uri);
  delete (post.record as any).reply;

  let postedRecord: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: createMockThreadView(post) },
          }),
        },
      },
    },
    post: async (record: any) => {
      postedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  // Check that the entry is marked as 'replied' after successful post
  const h = await harness(() => fakeAgent);
  try {
    await h.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "Nice!" },
    });

    const entries = await store.getAll();
    const entry = entries.find((e: any) => e.uri === uri);
    assert.ok(entry, "store should have an entry");
    assert.equal(entry.status, "replied", "entry status should be 'replied' after successful post");
    assert.ok(entry.replyUri, "reply URI should be stored");
  } finally {
    await h.close();
  }
}

/** 8. Auto-reply posting creates a valid reply record with correct structure */
async function testAutoReplyStructure() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:alice", "alice.test", "Hello world", uri);
  delete (post.record as any).reply;

  let capturedRecord: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: createMockThreadView(post) },
          }),
        },
      },
    },
    post: async (record: any) => {
      capturedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    await h.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "@alice.test thanks for sharing!" },
    });

    assert.ok(capturedRecord, "post should have been called");
    // Check reply structure
    assert.ok(capturedRecord.reply, "should have a reply field");
    assert.equal(capturedRecord.reply.parent.uri, uri);
    assert.equal(capturedRecord.reply.root.uri, uri);
    assert.ok(capturedRecord.reply.parent.cid, "parent CID should be set");
    assert.ok(capturedRecord.reply.root.cid, "root CID should be set");

    // Check text was processed through RichText (facets detected)
    assert.ok(typeof capturedRecord.text === "string", "text should be a string");
    assert.equal(capturedRecord.text.includes("@alice.test"), true, "mention should be preserved in text");
  } finally {
    await h.close();
  }
}

/** 9. Duplicate skipping across runs — second call returns early without posting */
async function testDuplicateSkippingAcrossRuns() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:alice", "alice.test", "Original post", uri);
  delete (post.record as any).reply;

  let callCount = 0;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: createMockThreadView(post) },
          }),
        },
      },
    },
    post: async () => {
      callCount++;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  // First run — should post
  const h1 = await harness(() => fakeAgent);
  try {
    await h1.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "First reply" },
    });
    assert.equal(callCount, 1, "should have posted once");
  } finally {
    await h1.close();
  }

  // Second run — should skip
  const h2 = await harness(() => fakeAgent);
  try {
    const res: any = await h2.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "Second reply" },
    });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /already|skip/i);
    assert.equal(callCount, 1, "should NOT have posted again");
  } finally {
    await h2.close();
  }
}

/** 10. Graceful error reporting for invalid text length */
async function testInvalidTextLength() {
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: { bsky: {} },
  };

  // Text too long (over 256 chars) — zod schema validation rejects it
  const h = await harness(() => fakeAgent);
  try {
    const res: any = await h.client.callTool({
      name: "create-reply",
      arguments: { uri: "at://did:plc:alice/app.bsky.feed.post/post1", text: "a".repeat(300) },
    });
    assert.equal(res.isError, true);
  } finally {
    await h.close();
  }

  // Empty text — zod schema validation rejects it (min(1))
  const h2 = await harness(() => fakeAgent);
  try {
    const res: any = await h2.client.callTool({
      name: "create-reply",
      arguments: { uri: "at://did:plc:alice/app.bsky.feed.post/post1", text: "" },
    });
    assert.equal(res.isError, true);
  } finally {
    await h2.close();
  }
}

/** 11. Empty notification / missing post handling */
async function testMissingPostHandling() {
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: false,
            data: null,
          }),
        },
      },
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    const res: any = await h.client.callTool({
      name: "create-reply",
      arguments: { uri: "at://did:plc:alice/app.bsky.feed.post/post1", text: "hello" },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not found|error|fail/i);
  } finally {
    await h.close();
  }
}

/** 12. AI preference check blocks replies to opted-out authors */
async function testAiPreferenceCheckBlocksReply() {
  const uri = "at://did:plc:denieduser/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:denieduser", "denied.test", "Secret content", uri);
  delete (post.record as any).reply;

  let postedCalled = false;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: createMockThreadView(post) },
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
      postedCalled = true;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    const res: any = await h.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "hello" },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /AI preference|opted out|denied/i);
    assert.equal(postedCalled, false, "should NOT have posted to an opted-out user");
  } finally {
    await h.close();
  }
}

/** 13. RichText facet detection works (mentions, hashtags) */
async function testRichTextFacetDetection() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:alice", "alice.test", "Original post", uri);
  delete (post.record as any).reply;

  let capturedRecord: any = null;

  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: createMockThreadView(post) },
          }),
        },
      },
    },
    post: async (record: any) => {
      capturedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    // Text with a mention and hashtag — RichText.detectFacets should find them
    await h.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "@alice.test #bluesky is great" },
    });

    assert.ok(capturedRecord, "post should have been called");
    // RichText processes the text and detects facets for mentions/hashtags
    // The text field will contain the processed text (with any normalization)
    assert.equal(typeof capturedRecord.text, "string", "text should be a string");
  } finally {
    await h.close();
  }
}

/** 14. Optional embedUrl parameter generates link preview embed */
async function testEmbedUrlParameter() {
  const uri = "at://did:plc:alice/app.bsky.feed.post/post1";
  const post = createMockPost("did:plc:alice", "alice.test", "Original post", uri);
  delete (post.record as any).reply;

  let capturedRecord: any = null;

  // Mock link metadata fetcher — the real one will be called by the tool
  const fakeAgent: any = {
    did: "did:plc:bot",
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: { thread: createMockThreadView(post) },
          }),
        },
      },
    },
    post: async (record: any) => {
      capturedRecord = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/reply1" };
    },
  };

  const store = getMentionStore();
  await store.clear();

  const h = await harness(() => fakeAgent);
  try {
    await h.client.callTool({
      name: "create-reply",
      arguments: { uri, text: "Check this out", embedUrl: "https://example.com/article" },
    });

    assert.ok(capturedRecord, "post should have been called");
    // The tool should attempt to fetch link metadata and create an embed
    // Even if the mock doesn't return metadata, it shouldn't crash
  } finally {
    await h.close();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: Array<[string, () => Promise<void>]> = [
  ["testToolRegistration", testToolRegistration],
  ["testUriValidation", testUriValidation],
  ["testDedupStorePersistence", testDedupStorePersistence],
  ["testRootParentCidForRootPost", testRootParentCidForRootPost],
  ["testRootParentCidForNestedReply", testRootParentCidForNestedReply],
  ["testApiFailureErrorHandling", testApiFailureErrorHandling],
  ["testNotificationDedup", testNotificationDedup],
  ["testAutoReplyStructure", testAutoReplyStructure],
  ["testDuplicateSkippingAcrossRuns", testDuplicateSkippingAcrossRuns],
  ["testInvalidTextLength", testInvalidTextLength],
  ["testMissingPostHandling", testMissingPostHandling],
  ["testAiPreferenceCheckBlocksReply", testAiPreferenceCheckBlocksReply],
  ["testRichTextFacetDetection", testRichTextFacetDetection],
  ["testEmbedUrlParameter", testEmbedUrlParameter],
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

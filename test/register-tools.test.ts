import { runTests } from "./test-helpers.js";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";
import {
  convertBskyUrlToAtUri,
  debugPostStructure,
  escapeXml,
  extractFirstUrl,
  facetsToMarkdown,
  formatSummaryText,
  getFeedNameFromId,
  mcpErrorResponse,
  mcpSuccessResponse,
  cleanHandle,
  parseBskyUrl,
  validateUri,
} from "../src/utils.js";
import { buildMentionReplyPrompt, generateMentionReply, registerPrompts } from "../src/prompts.js";
import { registerResources, resourcesList } from "../src/resources.js";

const EXPECTED_TOOLS = [
  "get-my-handle-and-did",
  "get-timeline-posts",
  "get-notifications",
  "create-post",
  "create-reply",
  "get-profile",
  "search-posts",
  "get-post-thread",
  "convert-url-to-uri",
  "search-people",
  "search-feeds",
  "get-liked-posts",
  "get-trends",
  "like-post",
  "follow-user",
  "unfollow-user",
  "get-pinned-feeds",
  "get-feed-posts",
  "get-list-posts",
  "get-user-posts",
  "get-follows",
  "get-followers",
  "get-post-likes",
  "get-mention-context",
  "run-mention-monitor",
  "list-resources",
];

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function testExpectedToolSet() {
  const { client, close } = await harness(() => null);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort(),
      `registered tool set drifted from the 23 expected names`);
  } finally {
    await close();
  }
}

async function testNullAgentReturnsError() {
  const { client, close } = await harness(() => null);
  try {
    const result: any = await client.callTool({ name: "get-my-handle-and-did", arguments: {} });
    assert.equal(result.isError, true, "expected isError when getAgent() returns null");
    assert.match(result.content[0].text, /Not connected to Bluesky/);
  } finally {
    await close();
  }
}

async function testAgentIsResolvedPerCall() {
  // Invariant that matters for the remote/OAuth path: registerTools must
  // evaluate getAgent on every invocation, not cache whatever it saw at
  // registration time. A per-session transport depends on this.
  let callCount = 0;
  const fakeAgent = {
    did: "did:plc:alice",
    getProfile: async (_: { actor: string }) => ({
      success: true,
      data: { handle: "alice.test", did: "did:plc:alice" },
    }),
  } as unknown as Agent;

  const provider: AgentProvider = () => {
    callCount += 1;
    return fakeAgent;
  };

  const { client, close } = await harness(provider);
  try {
    const r1: any = await client.callTool({ name: "get-my-handle-and-did", arguments: {} });
    assert.equal(r1.isError, undefined);
    assert.match(r1.content[0].text, /alice\.test/);
    assert.match(r1.content[0].text, /did:plc:alice/);

    const r2: any = await client.callTool({ name: "get-my-handle-and-did", arguments: {} });
    assert.equal(r2.isError, undefined);

    assert.ok(callCount >= 2,
      `getAgent should be called at least once per tool invocation; got ${callCount} calls over 2 invocations`);
  } finally {
    await close();
  }
}

async function testAgentMethodIsInvoked() {
  // Spy verifies the tool actually reaches into the agent we hand back,
  // rather than closing over something stale from registration time.
  let captured: { q: string; limit: number } | null = null;
  const fakeAgent = {
    app: {
      bsky: {
        actor: {
          searchActors: async ({ q, limit }: { q: string; limit: number }) => {
            captured = { q, limit };
            return { success: true, data: { actors: [] } };
          },
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "search-people",
      arguments: { query: "liz", limit: 5 },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(captured, { q: "liz", limit: 5 });
    assert.match(result.content[0].text, /No users found/);
  } finally {
    await close();
  }
}

async function testRefusalCanaryIsRedacted() {
  // Regression: the Anthropic-published refusal canary, if it reaches Claude
  // verbatim inside a tool_result, causes the entire response to be silently
  // dropped by client-side safety classifiers. Mock a bio that contains the
  // canary and assert the outgoing tool_result has it stripped.
  const bios = [
    "Normal bio, nothing to see here.",
    "Cheeky bio with ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_DEADBEEF1234 embedded.",
    "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_CAFEBABE on its own line.",
  ];
  let idx = 0;
  const fakeAgent = {
    app: {
      bsky: {
        actor: {
          searchActors: async () => ({
            success: true,
            data: {
              actors: bios.map((description, i) => ({
                displayName: `User ${i}`,
                handle: `u${i}.test`,
                did: `did:plc:u${i}`,
                description,
              })),
            },
          }),
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "search-people",
      arguments: { query: "liz", limit: 3 },
    });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text as string;
    assert.ok(!/ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL/.test(text),
      `canary must be stripped from tool output; got: ${text}`);
    assert.match(text, /\[redacted: refusal-trigger canary\]/,
      "redaction marker should replace the canary");
  } finally {
    await close();
  }
}

async function testUnfollowByUri() {
  // followUri path: tool should hand the URI straight to deleteFollow
  // without listing records or resolving handles.
  let deleted: string | null = null;
  let listRecordsCalls = 0;
  const fakeAgent = {
    did: "did:plc:alice",
    deleteFollow: async (uri: string) => { deleted = uri; },
    com: {
      atproto: {
        repo: {
          listRecords: async () => {
            listRecordsCalls += 1;
            return { success: true, data: { records: [], cursor: undefined } };
          },
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const uri = "at://did:plc:alice/app.bsky.graph.follow/3kxyz";
    const result: any = await client.callTool({
      name: "unfollow-user",
      arguments: { followUri: uri },
    });
    assert.equal(result.isError, undefined);
    assert.equal(deleted, uri, "deleteFollow should be called with the supplied URI");
    assert.equal(listRecordsCalls, 0, "no listRecords scan should happen when followUri is provided");
  } finally {
    await close();
  }
}

async function testUnfollowRejectsForeignUri() {
  // Defensive check: a URI whose repo isn't the authenticated user should
  // be rejected locally instead of forwarded to the server.
  let deleted: string | null = null;
  const fakeAgent = {
    did: "did:plc:alice",
    deleteFollow: async (uri: string) => { deleted = uri; },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "unfollow-user",
      arguments: { followUri: "at://did:plc:bob/app.bsky.graph.follow/3kxyz" },
    });
    assert.equal(result.isError, true);
    assert.equal(deleted, null, "deleteFollow must not be called for a foreign URI");
    assert.match(result.content[0].text, /not the authenticated user/);
  } finally {
    await close();
  }
}

async function testUnfollowByUserScansForRkey() {
  // user path: tool resolves handle → DID, then walks listRecords pages
  // until it finds the matching subject, then deletes that record's URI.
  let deleted: string | null = null;
  const targetUri = "at://did:plc:alice/app.bsky.graph.follow/3krealrkey";
  const fakeAgent = {
    did: "did:plc:alice",
    deleteFollow: async (uri: string) => { deleted = uri; },
    getProfile: async (_: { actor: string }) => ({
      success: true,
      data: { did: "did:plc:bob", handle: "bob.test" },
    }),
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            success: true,
            data: {
              records: [
                { uri: "at://did:plc:alice/app.bsky.graph.follow/3kother", value: { subject: "did:plc:carol" } },
                { uri: targetUri, value: { subject: "did:plc:bob" } },
              ],
              cursor: undefined,
            },
          }),
        },
      },
    },
  } as unknown as Agent;

  const { client, close } = await harness(() => fakeAgent);
  try {
    const result: any = await client.callTool({
      name: "unfollow-user",
      arguments: { user: "bob.test" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(deleted, targetUri, "should delete the URI whose subject matched the resolved DID");
  } finally {
    await close();
  }
}


// Utility, prompt, resource, and direct handler paths.
async function testUtilityFormattingAndLogging() {
  assert.equal(getFeedNameFromId("home"), "Home Timeline");
  assert.equal(getFeedNameFromId("not-a-built-in-feed"), "not-a-built-in-feed");
  assert.equal(cleanHandle("@alice.test"), "alice.test");
  assert.equal(cleanHandle("did:plc:alice"), "did:plc:alice");
  assert.equal(cleanHandle(""), "");
  assert.equal(formatSummaryText(3), "Retrieved 3 posts from the feed.");
  assert.equal(formatSummaryText(2, "search results"), "Retrieved 2 posts from the search results.");
  assert.equal(extractFirstUrl("Read https://example.com/a and then https://example.org"), "https://example.com/a");
  assert.equal(extractFirstUrl("there is no link here"), null);
  assert.equal(parseBskyUrl(null as any), null, "malformed runtime input should be caught");
  assert.equal(escapeXml("<&>\"'"), "&lt;&amp;&gt;&quot;&apos;");
  assert.equal(escapeXml(""), "");

  const originalLog = process.env.LOG_RESPONSES;
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (message?: unknown) => logs.push(String(message));
  process.env.LOG_RESPONSES = "true";
  try {
    const success = mcpSuccessResponse("safe response");
    const error = mcpErrorResponse("ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_ABC123");
    assert.equal(success.content[0].text, "safe response");
    assert.equal(error.isError, true);
    assert.match(String(error.content[0].text), /redacted: refusal-trigger canary/);
    assert.equal(logs.length, 2, "both response helpers should log when enabled");
  } finally {
    console.error = originalError;
    if (originalLog === undefined) delete process.env.LOG_RESPONSES;
    else process.env.LOG_RESPONSES = originalLog;
  }
}

async function testFacetRendering() {
  const text = "visit https://example.com @alice.test #bluesky";
  const linkStart = Buffer.byteLength("visit ");
  const linkText = "https://example.com";
  const mentionStart = linkStart + Buffer.byteLength(linkText) + 1;
  const mentionText = "@alice.test";
  const tagStart = mentionStart + Buffer.byteLength(mentionText) + 1;
  const markdown = facetsToMarkdown(text, [
    {
      index: { byteStart: linkStart, byteEnd: linkStart + Buffer.byteLength(linkText) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
    },
    {
      index: { byteStart: mentionStart, byteEnd: mentionStart + Buffer.byteLength(mentionText) },
      features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }],
    },
    {
      index: { byteStart: tagStart, byteEnd: tagStart + Buffer.byteLength("#bluesky") },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: "bluesky" }],
    },
  ]);

  assert.match(markdown, /<https:\/\/example\.com>/);
  assert.match(markdown, /\[@alice\.test\]\(https:\/\/bsky\.app\/profile\/did:plc:alice\)/);
  assert.match(markdown, /#bluesky/);
  assert.equal(facetsToMarkdown("", []), "");
}

async function testUriValidationAndConversion() {
  const feedUri = "at://did:plc:feed/app.bsky.feed.generator/custom";
  const listUri = "at://did:plc:list/app.bsky.graph.list/curated";
  const calls: string[] = [];
  const agent: any = {
    app: {
      bsky: {
        feed: {
          getFeedGenerator: async ({ feed }: any) => {
            calls.push(`feed:${feed}`);
            return { success: true, data: { uri: feed, view: { displayName: "Feed" } } };
          },
        },
        graph: {
          getList: async ({ list }: any) => {
            calls.push(`list:${list}`);
            return { success: true, data: { uri: list, list: { name: "List" } } };
          },
        },
      },
    },
    resolveHandle: async ({ handle }: any) => ({ success: true, data: { did: `did:plc:${handle}` } }),
  };

  assert.deepEqual(await validateUri(agent, feedUri, "feed"), { uri: feedUri, view: { displayName: "Feed" } });
  assert.deepEqual(await validateUri(agent, listUri, "feed"), { uri: listUri, list: { name: "List" } }, "list URI should use graph.getList even when type is feed");
  assert.deepEqual(await validateUri(agent, listUri, "list"), { uri: listUri, list: { name: "List" } });
  assert.deepEqual(calls, [`feed:${feedUri}`, `list:${listUri}`, `list:${listUri}`]);

  const unsuccessful: any = {
    app: { bsky: { feed: { getFeedGenerator: async () => ({ success: false }) }, graph: { getList: async () => ({ success: false }) } } },
  };
  assert.equal(await validateUri(unsuccessful, feedUri, "feed"), null);
  const throwing: any = {
    app: { bsky: { feed: { getFeedGenerator: async () => { throw new Error("down"); } } } },
  };
  assert.equal(await validateUri(throwing, feedUri, "feed"), null);

  assert.equal(await convertBskyUrlToAtUri("https://bsky.app/profile/alice.test/post/abc", agent), "at://did:plc:alice.test/app.bsky.feed.post/abc");
  assert.equal(await convertBskyUrlToAtUri("not a Bluesky URL", agent), null);
  const unresolved: any = { resolveHandle: async () => ({ success: false }) };
  assert.equal(await convertBskyUrlToAtUri("https://bsky.app/profile/alice.test/post/abc", unresolved), null);
  const resolverThrows: any = { resolveHandle: async () => { throw new Error("resolver down"); } };
  assert.equal(await convertBskyUrlToAtUri("https://bsky.app/profile/alice.test/post/abc", resolverThrows), null);
}

async function testDebugAndPromptBranches() {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (message?: unknown) => lines.push(String(message));
  try {
    debugPostStructure({
      record: { text: "hello", facets: [{ index: { byteStart: 0, byteEnd: 5 } }] },
      facets: [{ index: { byteStart: 0, byteEnd: 5 } }],
      uri: "at://did:plc:a/app.bsky.feed.post/1",
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(lines.some(line => line.includes("Record properties")));
  assert.ok(lines.some(line => line.includes("First facet at root")));

  const prompt = buildMentionReplyPrompt("alice.test", "Can you help?");
  assert.match(prompt, /alice\.test/);
  assert.match(prompt, /Can you help\?/);

  const short = generateMentionReply("alice.test", "Thanks for looking");
  assert.match(short, /@alice\.test/);
  assert.match(short, /Thanks for looking/);
  const noAuthor = generateMentionReply("", "");
  assert.match(noAuthor, /Thanks for the mention!/);
  const long = generateMentionReply("alice.test", "x".repeat(400));
  assert.ok(long.length <= 256);
  assert.match(long, /\.\.\./);
  const oversizedAuthor = generateMentionReply("a".repeat(300), "hello");
  assert.equal(oversizedAuthor.length, 255, "reply output should be truncated to the configured limit");
}

async function testResourcesAndPrompts() {
  const server = new McpServer({ name: "resource-test", version: "1.0.0" });
  registerResources(server);
  registerPrompts(server);
  const client = new Client({ name: "resource-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const resources = await client.listResources();
    assert.equal(resources.resources.length, resourcesList.length);
    assert.deepEqual(resources.resources.map((r) => r.uri).sort(), resourcesList.map((r) => r.uri).sort());

    const platform = await client.readResource({ uri: "bluesky://platform-info" });
    assert.match(String((platform.contents[0] as any).text), /Bluesky Platform Overview/);
    assert.match(String((platform.contents[0] as any).text), /AT Protocol/);

    const schema = await client.readResource({ uri: "bluesky://post-schema" });
    assert.match(String((schema.contents[0] as any).text), /Bluesky Post Schema Documentation/);
    assert.match(String((schema.contents[0] as any).text), /interface Post/);

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((p) => p.name), ["summarize-timeline"]);
    const prompt = await client.getPrompt({ name: "summarize-timeline", arguments: {} });
    assert.equal(prompt.messages[0].role, "user");
    assert.match((prompt.messages[0].content as any).text, /get my Bluesky timeline/);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}


async function callTool(agent: any, name: string, args: Record<string, unknown> = {}) {
  const h = await harness(() => agent);
  try {
    return await h.client.callTool({ name, arguments: args }) as any;
  } finally {
    await h.close();
  }
}

function text(result: any): string {
  return result.content?.[0]?.text ?? "";
}

function assertSuccess(result: any): string {
  assert.equal(result.isError, undefined, text(result));
  return text(result);
}

function assertError(result: any): string {
  assert.equal(result.isError, true, text(result));
  return text(result);
}

function postView(did: string, handle: string, uri = `at://${did}/app.bsky.feed.post/post`) {
  return {
    $type: "app.bsky.feed.defs#postView",
    uri,
    cid: "cid-post",
    author: { did, handle, displayName: handle.toUpperCase() },
    record: { text: "a searchable post", createdAt: "2026-08-01T12:00:00.000Z", facets: [] },
    indexedAt: "2026-08-01T12:00:00.000Z",
    likeCount: 1,
    repostCount: 2,
    replyCount: 3,
  };
}

function threadView(post: any) {
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post,
    replies: [],
  };
}

async function testCreatePostAndReplyReference() {
  let created: any;
  const rootUri = "at://did:plc:root-extra/app.bsky.feed.post/root";
  const replyUri = "at://did:plc:reply-extra/app.bsky.feed.post/reply";
  const agent: any = {
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({
            success: true,
            data: {
              thread: threadView({
                ...postView("did:plc:reply-extra", "reply.test", replyUri),
                record: {
                  text: "existing reply",
                  createdAt: "2026-08-01T12:00:00.000Z",
                  reply: {
                    root: { uri: rootUri, cid: "root-cid" },
                    parent: { uri: rootUri, cid: "root-cid" },
                  },
                },
              }),
            },
          }),
        },
      },
    },
    post: async (record: any) => {
      created = record;
      return { uri: "at://did:plc:bot/app.bsky.feed.post/new" };
    },
  };

  const result = await callTool(agent, "create-post", {
    text: "reply text",
    replyTo: replyUri,
    embedPreview: false,
  });
  assert.match(assertSuccess(result), /Post created successfully/);
  assert.equal(created.text, "reply text");
  assert.deepEqual(created.reply, {
    parent: { uri: replyUri, cid: "cid-post" },
    root: { uri: rootUri, cid: "root-cid" },
  });

  const badAgent: any = {
    app: { bsky: { feed: { getPostThread: async () => ({ success: false }) } } },
    post: async () => ({ uri: "never" }),
  };
  const bad = await callTool(badAgent, "create-post", { text: "reply", replyTo: replyUri, embedPreview: false });
  assert.match(assertError(bad), /Error parsing reply URI/);
}

async function testProfileSearchAndThreadTools() {
  const profileAgent: any = {
    getProfile: async ({ actor }: any) => ({
      success: true,
      data: {
        handle: actor,
        did: "did:plc:profile-extra",
        displayName: "Profile User",
        description: "A bio",
        followersCount: 12,
        followsCount: 13,
        postsCount: 14,
        labels: [{ val: "trusted" }],
      },
    }),
  };
  const profile = await callTool(profileAgent, "get-profile", { handle: "@profile.test" });
  assert.match(assertSuccess(profile), /Profile User/);
  assert.match(text(profile), /Labels: trusted/);

  const searchAgent: any = {
    app: {
      bsky: {
        feed: {
          searchPosts: async ({ q, limit, sort }: any) => {
            assert.equal(q, "cats");
            assert.equal(limit, 2);
            assert.equal(sort, "latest");
            return { success: true, data: { posts: [postView("did:plc:search-extra", "search.test")] } };
          },
          getPostThread: async ({ uri }: any) => ({ success: true, data: { thread: threadView({ ...postView("did:plc:thread-extra", "thread.test", uri) }) } }),
        },
      },
    },
    com: { atproto: { repo: { getRecord: async () => ({ success: false }) } } },
  };
  const search = await callTool(searchAgent, "search-posts", { query: "cats", limit: 2, sort: "latest" });
  assert.match(assertSuccess(search), /searchable post/);

  const uri = "at://did:plc:thread-extra/app.bsky.feed.post/thread";
  const thread = await callTool(searchAgent, "get-post-thread", { uri });
  assert.match(assertSuccess(thread), /<posts>/);
  assert.match(text(thread), /thread\.test/);

  const invalidThread = await callTool(searchAgent, "get-post-thread", { uri: "not-an-at-uri" });
  assert.match(assertError(invalidThread), /Invalid post URI format/);
}

async function testUrlSearchTrendsAndInteractions() {
  const resolveCalls: string[] = [];
  const agent: any = {
    resolveHandle: async ({ handle }: any) => {
      resolveCalls.push(handle);
      return { success: true, data: { did: "did:plc:follow-target" } };
    },
    follow: async (did: string) => { assert.equal(did, "did:plc:follow-target"); },
    api: {
      app: {
        bsky: {
          unspecced: {
            getPopularFeedGenerators: async () => ({
              success: true,
              data: {
                feeds: [{ displayName: "News Feed", uri: "at://feed/1", description: "News", creator: { handle: "creator.test", displayName: "Creator" }, likeCount: 7, indexedAt: "2026-08-01T12:00:00.000Z" }],
              },
            }),
            getTrendingTopics: async () => ({
              success: true,
              data: {
                topics: [{ topic: "Bluesky", postCount: 99, startTime: "2026-08-01T12:00:00.000Z", link: "/tag/bluesky" }],
                suggested: [{ topic: "ATProto", link: "/tag/atproto" }],
              },
            }),
          },
        },
      },
    },
    app: {
      bsky: {
        feed: {
          getPostThread: async () => ({ success: true, data: { thread: threadView(postView("did:plc:liked-extra", "liked.test")) } }),
        },
      },
    },
    like: async (uri: string, cid: string) => {
      assert.match(uri, /^at:\/\//);
      assert.equal(cid, "cid-post");
    },
  };

  const converted = await callTool(agent, "convert-url-to-uri", { url: "https://bsky.app/profile/target.test/post/rkey" });
  assert.match(assertSuccess(converted), /at:\/\/did:plc:follow-target\/app\.bsky\.feed\.post\/rkey/);

  const feeds = await callTool(agent, "search-feeds", { query: "news", limit: 1 });
  assert.match(assertSuccess(feeds), /News Feed/);
  assert.match(text(feeds), /Creator/);

  const trends = await callTool(agent, "get-trends", { limit: 1, includeSuggested: true });
  assert.match(assertSuccess(trends), /#1: Bluesky/);
  assert.match(text(trends), /Suggested Topics/);

  const likedUri = "at://did:plc:liked-extra/app.bsky.feed.post/liked";
  const liked = await callTool(agent, "like-post", { uri: likedUri });
  assert.match(assertSuccess(liked), /liked successfully/);
  const followed = await callTool(agent, "follow-user", { handle: "target.test" });
  assert.match(assertSuccess(followed), /Successfully followed @target.test/);
  assert.deepEqual(resolveCalls, ["target.test", "target.test"]);
}

async function testPinnedFeeds() {
  const agent: any = {
    app: {
      bsky: {
        actor: {
          getPreferences: async () => ({
            success: true,
            data: {
              preferences: [{
                $type: "app.bsky.actor.defs#savedFeedsPrefV2",
                items: [
                  { id: "custom", type: "feed", value: "at://did:plc:feed/app.bsky.feed.generator/news", pinned: true },
                  { id: "list", type: "list", value: "at://did:plc:list/app.bsky.graph.list/curated", pinned: true },
                  { id: "home", type: "timeline", value: "home", pinned: true },
                ],
              }],
            },
          }),
        },
        feed: {
          getFeedGenerator: async () => ({ success: true, data: { view: { displayName: "News Feed", description: "News", creator: { handle: "creator.test" } } } }),
        },
        graph: {
          getList: async () => ({ success: true, data: { list: { name: "Curated", description: "People", creator: { handle: "list-owner.test" }, purpose: "app.bsky.graph.defs#curatelist" }, items: [{}, {}] } }),
        },
      },
    },
  };
  const result = await callTool(agent, "get-pinned-feeds");
  const output = assertSuccess(result);
  assert.match(output, /News Feed/);
  assert.match(output, /Curated/);
  assert.match(output, /Members: 2/);
  assert.match(output, /Home Timeline/);

  const empty = await callTool({ app: { bsky: { actor: { getPreferences: async () => ({ success: true, data: { preferences: [] } }) } } } }, "get-pinned-feeds");
  assert.match(assertSuccess(empty), /No saved feeds found/);
}

async function testFollowsAndFollowers() {
  const selfAgent: any = {
    did: "did:plc:self-extra",
    getProfile: async () => ({ success: true, data: { did: "did:plc:self-extra", handle: "self.test", displayName: "Self" } }),
    com: { atproto: { repo: {
      listRecords: async () => ({ success: true, data: { records: [
        { uri: "at://did:plc:self-extra/app.bsky.graph.follow/a", value: { subject: "did:plc:one-extra" } },
        { uri: "at://did:plc:self-extra/app.bsky.graph.follow/b", value: { subject: "did:plc:two-extra" } },
      ], cursor: undefined } }),
    } } },
    app: { bsky: { actor: {
      getProfiles: async ({ actors }: any) => ({ success: true, data: { profiles: actors.map((did: string) => ({ did, handle: did.endsWith("one-extra") ? "one.test" : "two.test", displayName: "Detailed", description: "bio", followersCount: 1, followsCount: 2, postsCount: 3, indexedAt: "2026-08-01T12:00:00.000Z" })) } }),
    } } },
  };
  const selfFollows = await callTool(selfAgent, "get-follows", { user: "self.test", limit: 2, detail: "full" });
  assert.match(assertSuccess(selfFollows), /PDS-direct/);
  assert.match(text(selfFollows), /Follow Record URI/);
  assert.match(text(selfFollows), /Bio: bio/);

  const otherAgent: any = {
    did: "did:plc:viewer-extra",
    getProfile: async () => ({ success: true, data: { did: "did:plc:other-extra", handle: "other.test" } }),
    app: { bsky: { graph: {
      getFollows: async () => ({ success: true, data: { follows: [{ did: "did:plc:followed-extra", handle: "followed.test", displayName: "Followed" }], cursor: undefined } }),
    } } },
  };
  const otherFollows = await callTool(otherAgent, "get-follows", { user: "other.test", limit: 1, detail: "compact" });
  assert.match(assertSuccess(otherFollows), /AppView/);
  assert.match(text(otherFollows), /@followed\.test \(Followed\)/);

  const followerAgent: any = {
    getProfile: async () => ({ success: true, data: { did: "did:plc:followed-user", handle: "followed-user.test", displayName: "Followed User" } }),
    app: { bsky: { graph: {
      getFollowers: async () => ({ success: true, data: { followers: [{ did: "did:plc:follower-extra", handle: "follower.test", displayName: "Follower", description: "hello", followersCount: 4, followsCount: 5, postsCount: 6, indexedAt: "2026-08-01T12:00:00.000Z" }], cursor: undefined } }),
    } } },
  };
  const followers = await callTool(followerAgent, "get-followers", { user: "followed-user.test", limit: 1 });
  assert.match(assertSuccess(followers), /Retrieved 1 followers/);
  assert.match(text(followers), /Follower/);
}

async function testPostLikesAndResourceTool() {
  const uri = "at://did:plc:liked-post-extra/app.bsky.feed.post/liked";
  const agent: any = {
    app: { bsky: { feed: {
      getPostThread: async () => ({ success: true, data: { thread: threadView(postView("did:plc:liked-post-extra", "liked-post.test", uri)) } }),
      getLikes: async ({ cid, limit }: any) => {
        assert.equal(cid, "cid-post");
        assert.equal(limit, 2);
        return { success: true, data: { cursor: "likes-next", likes: [{
          actor: { did: "did:plc:liker-extra", handle: "liker.test", displayName: "Liker", description: "x".repeat(120), followersCount: 1, followsCount: 2, postsCount: 3 },
          indexedAt: "2026-08-01T12:00:00.000Z",
        }] } };
      },
    } } },
  };
  const likes = await callTool(agent, "get-post-likes", { uri, limit: 2 });
  assert.match(assertSuccess(likes), /Retrieved 1 likes/);
  assert.match(text(likes), /More likes are available/);
  assert.match(text(likes), /\.\.\./);

  const resources = await callTool({}, "list-resources");
  assert.match(assertSuccess(resources), /Available MCP Resources/);
  assert.match(text(resources), /bluesky-platform-info/);
}


async function main() {
  const cases: Array<[string, () => Promise<void>]> = [
    ["utility formatting, redaction, and logging", testUtilityFormattingAndLogging],
    ["facet-to-Markdown rendering", testFacetRendering],
    ["URI validation and URL conversion fallbacks", testUriValidationAndConversion],
    ["debug helper and mention prompt branches", testDebugAndPromptBranches],
    ["resource and prompt registration", testResourcesAndPrompts],
    ["create-post success and reply-reference error", testCreatePostAndReplyReference],
    ["profile, search-posts, and get-post-thread", testProfileSearchAndThreadTools],
    ["URL conversion, feed search, trends, like, and follow", testUrlSearchTrendsAndInteractions],
    ["pinned feed and list formatting", testPinnedFeeds],
    ["self/AppView follows and followers", testFollowsAndFollowers],
    ["post likes and list-resources", testPostLikesAndResourceTool],
    ["registers exactly the expected 23 tools", testExpectedToolSet],
    ["tools error out when getAgent returns null", testNullAgentReturnsError],
    ["getAgent is resolved per tool call, not cached", testAgentIsResolvedPerCall],
    ["tool handlers invoke methods on the resolved agent", testAgentMethodIsInvoked],
    ["Anthropic refusal canary is stripped from tool output", testRefusalCanaryIsRedacted],
    ["unfollow-user with followUri deletes directly", testUnfollowByUri],
    ["unfollow-user rejects URIs that aren't the authed user's", testUnfollowRejectsForeignUri],
    ["unfollow-user with user scans listRecords for the rkey", testUnfollowByUserScansForRkey],
  ];

  await runTests(cases);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

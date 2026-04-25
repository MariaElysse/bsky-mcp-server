import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";

const EXPECTED_TOOLS = [
  "get-my-handle-and-did",
  "get-timeline-posts",
  "create-post",
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
      `registered tool set drifted from the 22 expected names`);
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

async function main() {
  const cases: Array<[string, () => Promise<void>]> = [
    ["registers exactly the expected 22 tools", testExpectedToolSet],
    ["tools error out when getAgent returns null", testNullAgentReturnsError],
    ["getAgent is resolved per tool call, not cached", testAgentIsResolvedPerCall],
    ["tool handlers invoke methods on the resolved agent", testAgentMethodIsInvoked],
    ["unfollow-user with followUri deletes directly", testUnfollowByUri],
    ["unfollow-user rejects URIs that aren't the authed user's", testUnfollowRejectsForeignUri],
    ["unfollow-user with user scans listRecords for the rkey", testUnfollowByUserScansForRkey],
  ];

  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(err);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} / ${cases.length} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${cases.length} / ${cases.length} test(s) passed`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

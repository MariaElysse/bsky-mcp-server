#!/usr/bin/env node
import { runTests } from "./test-helpers.js";
/**
 * post-detail.test — the `detail: "full" | "compact"` parameter on every tool
 * that has one: the read-heavy post lists (get-timeline-posts, search-posts,
 * get-liked-posts, get-feed-posts, get-list-posts, get-user-posts) and
 * get-follows.
 *
 * For the post lists 'compact' prunes the same walk: it drops the `Engagement:`
 * line and the `bsky_url` attribute of every post (and of every quoted post)
 * and nothing else. `uri` stays on purpose — it is the argument
 * `get-post-thread`, `create-reply` and `like-post` take, so a compact read is
 * still a workable read. Post count, thread grouping, embeds and hidden-post
 * markers are identical either way.
 *
 * Covers:
 *  (1) the default is full: engagement counts and web URLs are present
 *  (2) compact removes both
 *  (3) compact keeps uri, type, author, content and timestamps
 *  (4) compact renders the same posts and is strictly smaller
 *  (5) the cursor signal survives compact mode
 *  (6) a second funnel (get-liked-posts) honours the parameter
 *  (7) get-follows shares the parameter, its default and its compact form
 */

import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Harness (same shape as test/pagination.test.ts — suites stay self-contained)
// ---------------------------------------------------------------------------

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function getText(result: any): string {
  return result.content?.[0]?.text ?? "";
}

/** A post with engagement counts, so full mode has an `Engagement:` line to drop. */
function post(id: number) {
  return {
    post: {
      uri: `at://did:plc:u${id}/app.bsky.feed.post/r${id}`,
      cid: `cid${id}`,
      author: { did: `did:plc:u${id}`, handle: `user${id}.test`, displayName: `User ${id}` },
      record: { text: `post number ${id}`, createdAt: "2021-08-04T13:30:00.000Z" },
      indexedAt: "2021-08-04T13:30:05.000Z",
      likeCount: id,
      repostCount: id + 1,
      replyCount: id + 2,
      quoteCount: id + 3,
    },
  };
}

/**
 * Mock agent handing out `pages` in order. Every call in `bothModes` gets a
 * fresh agent, so the default-detail call and the compact call see exactly the
 * same feed instead of the second one running into an exhausted page queue.
 */
function createAgent(pages: Array<{ feed: any[]; cursor?: string }>) {
  let call = 0;
  const next = async () => pages[call++] ?? { feed: [], cursor: undefined };

  return {
    getTimeline: async () => ({ success: true, data: await next() }),
    app: {
      bsky: {
        feed: {
          getActorLikes: async () => ({ success: true, data: await next() }),
        },
      },
    },
    // AI-preference lookups go through here; an empty record means "no
    // preferences set", which is what keeps these cases offline.
    com: {
      atproto: {
        repo: {
          getRecord: async () => ({ success: true, data: { uri: "at://viewer.test/none", cid: "cid", value: {} } }),
        },
      },
    },
    did: "did:plc:viewer",
    getProfile: async () => ({ success: true, data: { did: "did:plc:viewer", handle: "viewer.test" } }),
  } as unknown as Agent;
}

/** Call one tool twice — once with the default detail, once compact. */
async function bothModes(
  makeAgent: () => Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<{ full: string; compact: string }> {
  const runs: string[] = [];
  for (const detail of [undefined, "compact"] as const) {
    const { client, close } = await harness(makeAgent);
    try {
      const result: any = await client.callTool({
        name,
        arguments: detail ? { ...args, detail } : args,
      });
      assert.equal(result.isError, undefined, `${name}${detail ? ` (detail=${detail})` : ""} should not error`);
      runs.push(getText(result));
    } finally {
      await close();
    }
  }
  return { full: runs[0], compact: runs[1] };
}

/** The body text of every post, in order — the part compact mode must not touch. */
function postBodies(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => /^post number \d+$/.test(line));
}

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

// ---------------------------------------------------------------------------
// (1)–(5) get-timeline-posts
// ---------------------------------------------------------------------------

async function timelineDefaultIsFull() {
  const { full } = await bothModes(
    () => createAgent([{ feed: [post(1), post(2)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 2, type: "posts" },
  );

  assert.ok(full.includes("Engagement: 1 likes, 2 reposts, 3 replies"), "default should render engagement counts");
  assert.ok(full.includes("Engagement: 2 likes, 3 reposts, 4 replies"), "every post should carry its own counts");
  assert.ok(full.includes('bsky_url="https://bsky.app/profile/user1.test/post/r1"'), "default should render web URLs");
}

async function timelineCompactDropsCountsAndUrls() {
  const { full, compact } = await bothModes(
    () => createAgent([{ feed: [post(1), post(2)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 2, type: "posts" },
  );

  assert.ok(!compact.includes("Engagement:"), "compact should drop the engagement line");
  assert.ok(!compact.includes("bsky_url="), "compact should drop the bsky_url attribute");
  assert.ok(compact.includes("post number 1") && compact.includes("post number 2"), "compact should still return the posts");
  assert.ok(full.includes("Engagement:") && full.includes("bsky_url="), "control: the default has both");
}

async function timelineCompactKeepsUriTypeAndContent() {
  const { compact } = await bothModes(
    () => createAgent([{ feed: [post(1)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 1, type: "posts" },
  );

  // uri is what get-post-thread / create-reply / like-post take, so a compact
  // read has to stay actionable.
  assert.ok(
    compact.includes('<post type="standalone" uri="at://did:plc:u1/app.bsky.feed.post/r1" author_name="User 1"'),
    "compact should keep post type, uri and author on the opening tag",
  );
  assert.ok(compact.includes("</post>"), "compact should still close every post element");
  assert.ok(compact.includes("post number 1"), "compact should keep the post text");
  assert.ok(compact.includes("posted_at="), "compact should keep the timestamps");
}

async function timelineCompactRendersTheSamePostsAndIsSmaller() {
  const { full, compact } = await bothModes(
    () => createAgent([{ feed: [post(1), post(2), post(3)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 3, type: "posts" },
  );

  assert.deepEqual(postBodies(compact), postBodies(full), "compact must not drop or reorder posts");
  assert.equal(countOf(compact, "<post "), countOf(full, "<post "), "compact must render the same number of posts");
  assert.ok(compact.length < full.length, "compact should be strictly smaller than full");
  const saved = full.length - compact.length;
  assert.ok(saved / 3 > 40, `each post should shrink by a meaningful amount (saved ${saved} bytes over 3 posts)`);
}

async function timelineCompactStillSignalsTheCursor() {
  const { compact } = await bothModes(
    () => createAgent([{ feed: [post(1)], cursor: "timeline-page-2" }]),
    "get-timeline-posts",
    { count: 1, type: "posts" },
  );

  const match = compact.match(/pass cursor="([^"]+)" to continue/);
  assert.ok(match, "compact mode must not lose the pagination signal");
  assert.equal(match![1], "timeline-page-2", "the cursor signal should survive pruning unchanged");
}

// ---------------------------------------------------------------------------
// (6) a second funnel: get-liked-posts
// ---------------------------------------------------------------------------

async function likedPostsCompactHonoursTheParameter() {
  const { full, compact } = await bothModes(
    () => createAgent([{ feed: [post(7)], cursor: undefined }]),
    "get-liked-posts",
    { limit: 1 },
  );

  assert.ok(full.includes("Engagement: 7 likes, 8 reposts, 9 replies"), "default should render engagement counts");
  assert.ok(full.includes('bsky_url="https://bsky.app/profile/user7.test/post/r7"'), "default should render web URLs");
  assert.ok(!compact.includes("Engagement:") && !compact.includes("bsky_url="), "compact should drop both");
  assert.ok(compact.includes('uri="at://did:plc:u7/app.bsky.feed.post/r7"'), "compact should keep the uri");
}

// ---------------------------------------------------------------------------
// (7) the other tool with a `detail` parameter: get-follows
// ---------------------------------------------------------------------------

/**
 * A self-follows agent: `get-follows` reads the viewer's own graph straight
 * from the PDS, which is the path that also carries the follow record URI.
 */
function createFollowAgent(): Agent {
  const profileOf = (did: string) => ({
    did,
    handle: did.endsWith("-one") ? "one.test" : "two.test",
    displayName: did.endsWith("-one") ? "One Test" : "Two Test",
    description: "a bio that compact mode skips",
    followersCount: 10,
    followsCount: 20,
    postsCount: 30,
    indexedAt: "2021-08-04T13:32:00.000Z",
  });

  return {
    did: "did:plc:viewer",
    getProfile: async () => ({ success: true, data: { did: "did:plc:viewer", handle: "self.test" } }),
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            success: true,
            data: {
              records: [
                { uri: "at://did:plc:viewer/app.bsky.graph.follow/one", value: { subject: "did:plc:subject-one" } },
                { uri: "at://did:plc:viewer/app.bsky.graph.follow/two", value: { subject: "did:plc:subject-two" } },
              ],
              cursor: undefined,
            },
          }),
        },
      },
    },
    app: {
      bsky: {
        actor: {
          // Counts only exist on the hydrated Detailed view, which is why full
          // detail hydrates every DID and compact only the unresolved ones.
          getProfiles: async ({ actors }: any) => ({ success: true, data: { profiles: actors.map(profileOf) } }),
        },
      },
    },
  } as unknown as Agent;
}

async function followsDefaultIsFullAndCompactIsOneLinePerFollow() {
  const { full, compact } = await bothModes(createFollowAgent, "get-follows", { user: "self.test", limit: 2 });

  // `get-follows` is the tool whose default flipped: it used to render the
  // cheap one-line form unless the caller asked for `detail="full"`.
  assert.ok(full.includes("Display Name: One Test"), "the default should render the full block");
  assert.ok(full.includes("Bio: a bio that compact mode skips"), "full should include the bio");
  assert.ok(full.includes("Followers: 10"), "full should include the counts");
  assert.ok(full.includes("Follow Record URI: at://did:plc:viewer/app.bsky.graph.follow/one"), "full should name the follow record");

  assert.ok(!compact.includes("Bio:") && !compact.includes("Followers:"), "compact should drop bios and counts");
  assert.ok(
    compact.includes("1. @one.test (One Test) — did:plc:subject-one [at://did:plc:viewer/app.bsky.graph.follow/one]"),
    "compact should render one line per follow, with the follow record URI bracketed",
  );

  assert.equal(countOf(full, "did:plc:subject"), 2, "full should render every follow");
  assert.equal(countOf(compact, "did:plc:subject"), 2, "compact should render the same follows");
  assert.ok(compact.length < full.length, "compact should be strictly smaller");
  const compactLines = compact.trim().split("\n").length;
  const fullLines = full.trim().split("\n").length;
  assert.ok(fullLines / compactLines > 3, `the saving should scale per entry (full ${fullLines} lines vs compact ${compactLines})`);
}

async function main() {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ["get-timeline-posts: default detail renders engagement counts and web URLs", timelineDefaultIsFull],
    ["get-timeline-posts: detail=compact drops engagement counts and web URLs", timelineCompactDropsCountsAndUrls],
    ["get-timeline-posts: detail=compact keeps uri, type, author and content", timelineCompactKeepsUriTypeAndContent],
    ["get-timeline-posts: detail=compact renders the same posts and costs fewer characters", timelineCompactRendersTheSamePostsAndIsSmaller],
    ["get-timeline-posts: detail=compact still advertises the cursor signal", timelineCompactStillSignalsTheCursor],
    ["get-liked-posts: detail=compact prunes the same lines the default emits", likedPostsCompactHonoursTheParameter],
    ["get-follows: the default is the full block and compact is one line per follow", followsDefaultIsFullAndCompactIsOneLinePerFollow],
  ];

  await runTests(cases);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

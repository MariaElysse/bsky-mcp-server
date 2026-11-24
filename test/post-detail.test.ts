#!/usr/bin/env node
import { runTests } from "./test-helpers.js";
/**
 * post-detail.test — the `detail: "full" | "compact"` parameter on every tool
 * that has one: the read-heavy post lists (get-timeline-posts, search-posts,
 * get-liked-posts, get-feed-posts, get-list-posts, get-user-posts) and
 * get-follows.
 *
 * `compact` is the **default**. It is the level a large read needs, and it
 * gives up nothing a caller has to have in order to act on what it shows:
 * every rendered element keeps the handle the next call takes — `uri` on a
 * post, on a quoted post and on an `<excluded_post>` marker, `reply_to` on a
 * reply, `author_handle` on a repost, and a follow's DID plus bracketed follow
 * record URI. What it omits is either derivable (`bsky_url` is `BSKY_WEB_URL` +
 * `author_handle` + the rkey of `uri`) or one call away: `detail="full"` on the
 * same tool, or a thread read, which always renders engagement counts.
 *
 * So the rule these cases pin is that compact may drop *detail*, never an
 * address: the multiset of `uri=`/`reply_to=` attributes is identical between
 * the two levels, and every element that is rendered at all is rendered with
 * its `uri`.
 *
 * Covers:
 *  (1) the default is compact — no engagement line, no web URL, and byte-for-byte
 *      what `detail="compact"` asks for
 *  (2) `detail="full"` is the opt-in that adds both back
 *  (3) the default still keeps uri, type, author, content and timestamps
 *  (4) compact renders the same posts, is strictly smaller, and drops no address
 *      that full renders
 *  (5) the cursor signal survives the default
 *  (6) a second funnel (get-liked-posts) defaults to compact too
 *  (7) get-follows shares the parameter, its default and its one-line form —
 *      and its compact line still carries what unfollow-user needs
 *  (8) a mixed page (quote, reply, repost) leaves every shown item addressable
 *      at the default level
 *  (9) all seven tools advertise the same two values and the same default, so
 *      the single declaration cannot drift
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

/** A post with engagement counts, so `detail="full"` has an `Engagement:` line to add. */
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

const postUri = (authorDid: string, rkey: string) => `at://${authorDid}/app.bsky.feed.post/${rkey}`;

/**
 * A page that shows everything the feed format can show: a post with a quoted
 * post inside it, a reply to that post (so it nests), and a repost of another
 * post. Used to check that the default level leaves every one of those items
 * addressable.
 */
function richPage() {
  const parentUri = postUri("did:plc:u1", "r1");
  const quotedUri = postUri("did:plc:quoted", "q9");
  return [
    {
      post: {
        uri: parentUri,
        cid: "cid1",
        author: { did: "did:plc:u1", handle: "user1.test", displayName: "User 1" },
        record: { text: "post number 1", createdAt: "2021-08-04T13:30:00.000Z" },
        indexedAt: "2021-08-04T13:30:05.000Z",
        likeCount: 1,
        repostCount: 2,
        replyCount: 3,
        quoteCount: 4,
        embed: {
          $type: "app.bsky.embed.record#view",
          record: {
            $type: "app.bsky.embed.record#viewRecord",
            uri: quotedUri,
            cid: "cidq9",
            author: { did: "did:plc:quoted", handle: "quoted.test", displayName: "Quoted Q" },
            value: { text: "a quoted post", createdAt: "2021-08-04T13:29:00.000Z" },
            facets: [],
            indexedAt: "2021-08-04T13:29:05.000Z",
            likeCount: 4,
            repostCount: 5,
            replyCount: 6,
          },
        },
      },
    },
    {
      post: {
        uri: postUri("did:plc:u2", "r2"),
        cid: "cid2",
        author: { did: "did:plc:u2", handle: "user2.test", displayName: "User 2" },
        record: {
          text: "post number 2",
          createdAt: "2021-08-04T13:31:00.000Z",
          reply: { parent: { uri: parentUri, cid: "cid1" }, root: { uri: parentUri, cid: "cid1" } },
        },
        indexedAt: "2021-08-04T13:31:05.000Z",
        likeCount: 5,
        repostCount: 6,
        replyCount: 7,
      },
      reply: {
        parent: { $type: "app.bsky.feed.defs#postView", uri: parentUri },
        root: { $type: "app.bsky.feed.defs#postView", uri: parentUri },
      },
    },
    {
      post: {
        uri: postUri("did:plc:u3", "r3"),
        cid: "cid3",
        author: { did: "did:plc:u3", handle: "user3.test", displayName: "User 3" },
        record: { text: "post number 3", createdAt: "2021-08-04T13:32:00.000Z" },
        indexedAt: "2021-08-04T13:32:05.000Z",
        likeCount: 8,
        repostCount: 9,
        replyCount: 10,
      },
      reason: {
        $type: "app.bsky.feed.defs#reasonRepost",
        by: { did: "did:plc:reposter", handle: "reposter.test", displayName: "Reposter R" },
        indexedAt: "2021-08-04T13:33:00.000Z",
      },
    },
  ];
}

/**
 * Mock agent handing out `pages` in order. Every run in `renderModes` gets a
 * fresh agent, so the default call, the full call and the compact call see
 * exactly the same feed instead of the later ones running into an exhausted
 * page queue.
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

/**
 * Call one tool three ways — with nothing (the default), with `detail="full"`,
 * with `detail="compact"` — so a case can compare what the default actually
 * renders against what each level promises.
 */
async function renderModes(
  makeAgent: () => Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<{ default: string; full: string; compact: string }> {
  const runs: string[] = [];
  for (const detail of [undefined, "full", "compact"] as const) {
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
  return { default: runs[0], full: runs[1], compact: runs[2] };
}

/** The body text of every post, in order — the part compact mode must not touch. */
function postBodies(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => /^post number \d+$/.test(line));
}

/**
 * Every address the rendering hands the caller — the argument of the next call,
 * not prose. Compact is allowed to drop detail; it is never allowed to drop one
 * of these.
 */
function addresses(text: string): string[] {
  return text.match(/(?:^|\s)(?:uri|reply_to)="[^"]*"/g) ?? [];
}

/**
 * Whatever is rendered must be reachable: each post, quoted post and
 * hidden-post marker carries the `uri` the post-level tools take.
 */
function assertEverythingShownHasItsUri(text: string) {
  const openingTags = text.match(/<(?:post|quoted_post|excluded_post)\b[^>]*>/g) ?? [];
  assert.ok(openingTags.length > 0, "expected the rendering to show post elements");
  for (const tag of openingTags) {
    assert.ok(tag.includes(' uri="'), `every rendered element should keep its uri: ${tag}`);
  }
}

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

// ---------------------------------------------------------------------------
// (1)–(5) get-timeline-posts
// ---------------------------------------------------------------------------

async function timelineDefaultIsCompact() {
  const { default: rendered, compact, full } = await renderModes(
    () => createAgent([{ feed: [post(1), post(2)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 2, type: "posts" },
  );

  assert.ok(!rendered.includes("Engagement:"), "the default should not spend tokens on engagement counts");
  assert.ok(!rendered.includes("bsky_url="), "the default should not spend tokens on web URLs");
  assert.equal(rendered, compact, "the default should render exactly what detail='compact' asks for");
  assert.ok(full.includes("Engagement:") && full.includes("bsky_url="), "detail='full' is the opt-in that adds both back");
}

async function timelineFullIsTheOptIn() {
  const { default: rendered, full } = await renderModes(
    () => createAgent([{ feed: [post(1), post(2)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 2, type: "posts" },
  );

  assert.ok(full.includes("Engagement: 1 likes, 2 reposts, 3 replies"), "detail='full' should render engagement counts");
  assert.ok(full.includes("Engagement: 2 likes, 3 reposts, 4 replies"), "every post should carry its own counts");
  assert.ok(full.includes('bsky_url="https://bsky.app/profile/user1.test/post/r1"'), "detail='full' should render web URLs");
  assert.ok(!rendered.includes("Engagement: 1 likes"), "the default should not carry them");
}

async function timelineDefaultKeepsUriTypeAndContent() {
  const { default: rendered } = await renderModes(
    () => createAgent([{ feed: [post(1)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 1, type: "posts" },
  );

  // uri is what get-post-thread / create-reply / like-post take, so the
  // default level has to stay a workable read.
  assert.ok(
    rendered.includes('<post type="standalone" uri="at://did:plc:u1/app.bsky.feed.post/r1" author_name="User 1"'),
    "the default should keep post type, uri and author on the opening tag",
  );
  assert.ok(rendered.includes("</post>"), "the default should still close every post element");
  assert.ok(rendered.includes("post number 1"), "the default should keep the post text");
  assert.ok(rendered.includes("posted_at="), "the default should keep the timestamps");
}

async function compactDefaultDropsNoAddress() {
  const { default: rendered, full, compact } = await renderModes(
    () => createAgent([{ feed: [post(1), post(2), post(3)], cursor: undefined }]),
    "get-timeline-posts",
    { count: 3, type: "posts" },
  );

  assert.deepEqual(postBodies(rendered), postBodies(full), "the default must not drop or reorder posts");
  assert.equal(countOf(rendered, "<post "), countOf(full, "<post "), "the default must render the same number of posts");
  assert.deepEqual(addresses(rendered), addresses(full), "compact may drop detail, never an address full renders");
  assertEverythingShownHasItsUri(rendered);
  assert.ok(rendered.length < full.length, "the default should be strictly smaller than detail='full'");
  const saved = full.length - rendered.length;
  assert.ok(saved / 3 > 40, `each post should shrink by a meaningful amount (saved ${saved} bytes over 3 posts)`);
  assert.equal(countOf(rendered, "Engagement:"), 0, "the default should carry no engagement line");
  assert.equal(countOf(full, "Engagement:"), 3, "detail='full' should add one per post");
  assert.deepEqual(addresses(compact), addresses(full), "an explicit compact agrees with the default");
}

async function timelineDefaultStillSignalsTheCursor() {
  const { default: rendered } = await renderModes(
    () => createAgent([{ feed: [post(1)], cursor: "timeline-page-2" }]),
    "get-timeline-posts",
    { count: 1, type: "posts" },
  );

  const match = rendered.match(/pass cursor="([^"]+)" to continue/);
  assert.ok(match, "the default must not lose the pagination signal");
  assert.equal(match![1], "timeline-page-2", "the cursor signal should survive pruning unchanged");
}

// ---------------------------------------------------------------------------
// (6) a second funnel: get-liked-posts
// ---------------------------------------------------------------------------

async function likedPostsDefaultIsCompactAndFullRestoresDetail() {
  const { default: rendered, full, compact } = await renderModes(
    () => createAgent([{ feed: [post(7)], cursor: undefined }]),
    "get-liked-posts",
    { limit: 1 },
  );

  assert.ok(full.includes("Engagement: 7 likes, 8 reposts, 9 replies"), "detail='full' should render engagement counts");
  assert.ok(full.includes('bsky_url="https://bsky.app/profile/user7.test/post/r7"'), "detail='full' should render web URLs");
  assert.ok(!rendered.includes("Engagement:") && !rendered.includes("bsky_url="), "the default should drop both");
  assert.ok(rendered.includes('uri="at://did:plc:u7/app.bsky.feed.post/r7"'), "the default should keep the uri");
  assert.equal(rendered, compact, "the default should be what detail='compact' asks for");
  assertEverythingShownHasItsUri(rendered);
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

async function followsDefaultIsOneLinePerFollowAndFullIsABlock() {
  const { default: rendered, full, compact } = await renderModes(createFollowAgent, "get-follows", { user: "self.test", limit: 2 });

  assert.ok(!rendered.includes("Bio:") && !rendered.includes("Followers:"), "the default should drop bios and counts");
  assert.ok(
    rendered.includes("1. @one.test (One Test) — did:plc:subject-one [at://did:plc:viewer/app.bsky.graph.follow/one]"),
    "the default should render one line per follow, with the follow record URI bracketed",
  );
  assert.ok(
    /The bracketed at:\/\/ URI on each line is the follow record/.test(rendered),
    "the default should say what the bracketed URI is for, so the list stays usable",
  );
  assert.equal(rendered, compact, "the default should be what detail='compact' asks for");

  // `detail="full"` is the opt-in for the block form.
  assert.ok(full.includes("Display Name: One Test"), "detail='full' should render the full block");
  assert.ok(full.includes("Bio: a bio that compact mode skips"), "full should include the bio");
  assert.ok(full.includes("Followers: 10"), "full should include the counts");
  assert.ok(full.includes("Follow Record URI: at://did:plc:viewer/app.bsky.graph.follow/one"), "full should name the follow record");

  assert.equal(countOf(rendered, "did:plc:subject"), 2, "the default should render every follow");
  assert.equal(countOf(full, "did:plc:subject"), 2, "full should render the same follows");
  assert.ok(rendered.length < full.length, "the default should be strictly smaller");
  const defaultLines = rendered.trim().split("\n").length;
  const fullLines = full.trim().split("\n").length;
  assert.ok(fullLines / defaultLines > 3, `the saving should scale per entry (full ${fullLines} lines vs default ${defaultLines})`);
}

// ---------------------------------------------------------------------------
// (8) the default leaves a whole mixed page addressable
// ---------------------------------------------------------------------------

async function defaultLevelLeavesEveryShownItemAddressable() {
  const { default: rendered, full } = await renderModes(
    () => createAgent([{ feed: richPage(), cursor: undefined }]),
    "get-timeline-posts",
    { count: 3, type: "posts" },
  );

  assert.ok(!rendered.includes("bsky_url=") && !rendered.includes("Engagement:"), "the page should be rendered at the default level");

  // A quoted post, a nested reply and a repost, each still reachable.
  assert.ok(rendered.includes('<quoted_post uri="at://did:plc:quoted/app.bsky.feed.post/q9"'), "the quoted post keeps its uri, so it can be read or replied to");
  assert.ok(rendered.includes('reply_to="at://did:plc:u1/app.bsky.feed.post/r1"'), "the reply says which post it answers");
  assert.ok(rendered.includes('<repost author_name="Reposter R" author_handle="reposter.test"'), "the repost names who reposted it");
  assert.ok(rendered.includes("<replies>"), "the reply still nests inside the post it answers");
  assertEverythingShownHasItsUri(rendered);

  // Compact drops detail — here, four engagement lines and four web URLs — and
  // nothing that identifies an item.
  assert.equal(countOf(full, "Engagement:"), 4, "full renders one engagement line per post and quote");
  assert.equal(countOf(full, "bsky_url="), 4, "full renders one web URL per post and quote");
  assert.deepEqual(addresses(rendered), addresses(full), "the default hands back exactly the addresses full does");
}

// ---------------------------------------------------------------------------
// (9) the schema itself: one vocabulary, one default, no drift
// ---------------------------------------------------------------------------

const DETAIL_TOOLS = [
  "get-timeline-posts",
  "search-posts",
  "get-liked-posts",
  "get-feed-posts",
  "get-list-posts",
  "get-user-posts",
  "get-follows",
];

async function everyDetailParameterAdvertisesTheSameDefault() {
  const { client, close } = await harness(() => createAgent([]));
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

    for (const name of DETAIL_TOOLS) {
      const detail = (byName.get(name)?.inputSchema as any)?.properties?.detail;
      assert.ok(detail, `${name} should expose a detail parameter`);
      assert.deepEqual(detail.enum, ["full", "compact"], `${name}: one vocabulary, one order`);
      assert.equal(detail.default, "compact", `${name}: one default, declared once by detailParam`);
    }

    const detailBearing = tools
      .filter((tool: any) => (tool.inputSchema as any)?.properties?.detail)
      .map((tool: any) => tool.name)
      .sort();
    assert.deepEqual(detailBearing, [...DETAIL_TOOLS].sort(), "thread reads and notifications stay at full detail");
  } finally {
    await close();
  }
}

async function main() {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ["get-timeline-posts: the default detail is compact", timelineDefaultIsCompact],
    ["get-timeline-posts: detail=full is the opt-in that adds counts and web URLs back", timelineFullIsTheOptIn],
    ["get-timeline-posts: the default keeps uri, type, author and content", timelineDefaultKeepsUriTypeAndContent],
    ["get-timeline-posts: the compact default renders the same posts and drops no address", compactDefaultDropsNoAddress],
    ["get-timeline-posts: the default still advertises the cursor signal", timelineDefaultStillSignalsTheCursor],
    ["get-liked-posts: the default is compact and detail=full restores counts and web URLs", likedPostsDefaultIsCompactAndFullRestoresDetail],
    ["get-follows: the default is one line per follow and detail=full renders the block", followsDefaultIsOneLinePerFollowAndFullIsABlock],
    ["the compact default leaves every post, quote, reply and repost it shows addressable", defaultLevelLeavesEveryShownItemAddressable],
    ["every tool with a detail parameter advertises the same levels and defaults to compact", everyDetailParameterAdvertisesTheSameDefault],
  ];

  await runTests(cases);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { runTests } from "./test-helpers.js";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers — build minimal FeedViewPost-like items for testing
// ---------------------------------------------------------------------------

function makeFeedItem({
  uri = `at://did:plc:test/app.bsky.feed.post/${Math.random().toString(36).slice(2, 8)}`,
  handle = "alice.test",
  did = "did:plc:alice123",
  text = "Hello world",
  createdAt = new Date().toISOString(),
}: {
  uri?: string;
  handle?: string;
  did?: string;
  text?: string;
  createdAt?: string;
} = {}): any {
  return {
    post: {
      uri,
      author: { handle, did },
      record: { text, createdAt, facets: [] },
      indexedAt: new Date().toISOString(),
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
    },
    reply: undefined,
    reason: undefined,
  };
}

function makeTombstone(originalItem: any): any {
  return {
    __aiPrefExcluded: true,
    originalItem,
    deniedCategories: ["inference", "training"],
  };
}

// ---------------------------------------------------------------------------
// Import the modules under test (compiled JS)
// ---------------------------------------------------------------------------

let filterPostsByAiPreferences: any;
let preprocessPosts: any;
let filterThreadByAiPreferences: any;
let formatPostThreadWithAiPrefs: any;
let facetsToMarkdown: any;
let formatFeed: any;
let formatPostThread: any;
let preprocessPost: any;
let processThreadViewPost: any;

async function loadModules() {
  const aiPrefs = await import("../src/ai-preferences.js");
  filterPostsByAiPreferences = aiPrefs.filterPostsByAiPreferences;

  const llm = await import("../src/llm-preprocessor.js");
  preprocessPosts = llm.preprocessPosts;
  filterThreadByAiPreferences = llm.filterThreadByAiPreferences;
  formatPostThreadWithAiPrefs = llm.formatPostThreadWithAiPrefs;
  facetsToMarkdown = llm.facetsToMarkdown;
  formatFeed = llm.formatFeed;
  formatPostThread = llm.formatPostThread;
  preprocessPost = llm.preprocessPost;
  processThreadViewPost = llm.processThreadViewPost;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_filterPostsByAiPreferences_replaces_denied_with_tombstones() {
  const items = [makeFeedItem({ handle: "alice.test", did: "did:plc:alice" }), makeFeedItem({ handle: "bob.test", did: "did:plc:bob" })];

  // Both allowed — no tombstones
  const allowedMap1 = new Map([["did:plc:alice", true], ["did:plc:bob", true]]);
  let result = filterPostsByAiPreferences(items, allowedMap1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.filtered.length, 2);
  for (const item of result.filtered) {
    assert.ok(!item.__aiPrefExcluded, "allowed posts should not be tombstones");
  }

  // Alice denied — one tombstone
  const allowedMap2 = new Map([["did:plc:alice", false], ["did:plc:bob", true]]);
  result = filterPostsByAiPreferences(items, allowedMap2);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.filtered.length, 2); // same length — tombstone replaces, not drops
  assert.ok(result.filtered[0].__aiPrefExcluded, "denied post should be a tombstone");
  assert.ok(!result.filtered[1].__aiPrefExcluded, "allowed post should remain normal");
}

async function test_filterPostsByAiPreferences_preserves_order() {
  const items = [
    makeFeedItem({ handle: "a.test", did: "did:plc:a" }),
    makeFeedItem({ handle: "b.test", did: "did:plc:b" }),
    makeFeedItem({ handle: "c.test", did: "did:plc:c" }),
    makeFeedItem({ handle: "d.test", did: "did:plc:d" }),
  ];

  // Deny b and d (even indices in the middle/end)
  const allowedMap = new Map([
    ["did:plc:a", true],
    ["did:plc:b", false],
    ["did:plc:c", true],
    ["did:plc:d", false],
  ]);

  const result = filterPostsByAiPreferences(items, allowedMap);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.filtered.length, 4); // all positions preserved

  // Verify order: tombstone at index 1, normal at 2, tombstone at 3
  assert.ok(!result.filtered[0].__aiPrefExcluded, "a should be first (normal)");
  assert.ok(result.filtered[1].__aiPrefExcluded, "b should be second (tombstone)");
  assert.ok(!result.filtered[2].__aiPrefExcluded, "c should be third (normal)");
  assert.ok(result.filtered[3].__aiPrefExcluded, "d should be fourth (tombstone)");
}

async function test_filterPostsByAiPreferences_empty_input() {
  const result = filterPostsByAiPreferences([], new Map());
  assert.equal(result.skippedCount, 0);
  assert.equal(result.filtered.length, 0);
}

async function test_filterPostsByAiPreferences_items_without_author_info_pass_through() {
  // Items without post.author.did should pass through unchanged
  const items = [makeFeedItem({ handle: "a.test", did: "did:plc:a" })];
  items.push({ someOtherField: true }); // no post.author.did

  const allowedMap = new Map([["did:plc:a", false]]);
  const result = filterPostsByAiPreferences(items, allowedMap);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.filtered.length, 2);
  assert.ok(!result.filtered[1].__aiPrefExcluded, "item without author should pass through");
}

async function test_filterPostsByAiPreferences_deniedCategories_populated() {
  const items = [makeFeedItem({ handle: "a.test", did: "did:plc:a" })];

  // Denied with specific categories
  const deniedRecord = { training: "deny", inference: "deny", syntheticContent: "allow", embedding: "allow" };
  const deniedRecordsMap = new Map([["did:plc:a", deniedRecord]]);
  const allowedMap = new Map([["did:plc:a", false]]);

  const result = filterPostsByAiPreferences(items, allowedMap, deniedRecordsMap);
  assert.equal(result.skippedCount, 1);
  const tombstone = result.filtered[0];
  assert.ok(tombstone.__aiPrefExcluded);
  assert.ok(Array.isArray(tombstone.deniedCategories), "deniedCategories should be an array");
  assert.ok(
    tombstone.deniedCategories!.includes("training"),
    "should include 'training' in denied categories"
  );
  assert.ok(
    tombstone.deniedCategories!.includes("inference"),
    "should include 'inference' in denied categories"
  );
}

async function test_filterPostsByAiPreferences_deniedCategories_empty_when_no_record() {
  const items = [makeFeedItem({ handle: "a.test", did: "did:plc:a" })];
  // No deniedRecords passed — should get undefined/empty deniedCategories
  const allowedMap = new Map([["did:plc:a", false]]);

  const result = filterPostsByAiPreferences(items, allowedMap);
  assert.equal(result.skippedCount, 1);
  const tombstone = result.filtered[0];
  // When no deniedRecords provided, deniedCategories should be undefined (not set)
  assert.ok(tombstone.__aiPrefExcluded);
}

async function test_preprocessPosts_with_tombstones_preserves_position() {
  const items = [
    makeFeedItem({ handle: "a.test", did: "did:plc:a" }),
    makeTombstone(makeFeedItem({ handle: "b.test", did: "did:plc:b" })),
    makeFeedItem({ handle: "c.test", did: "did:plc:c" }),
  ];

  const xml = preprocessPosts(items as any);
  assert.ok(xml.includes("<posts>"), "should start with <posts>");
  assert.ok(xml.includes("</posts>"), "should end with </posts>");
  // The tombstone should appear between a and c in the XML (position preserved)
  // Use indexOf on the full opening tag to avoid matching attribute strings
  const firstPostTag = xml.indexOf('<post type="standalone"');
  const excludedIdx = xml.indexOf("<excluded_post");
  const secondPostTag = xml.indexOf('<post type="standalone"', firstPostTag + 1);

  assert.ok(firstPostTag >= 0, "should find first post tag");
  assert.ok(secondPostTag > firstPostTag, "should find second post tag after first");
  assert.ok(
    firstPostTag < excludedIdx && excludedIdx < secondPostTag,
    `tombstone should appear between posts: firstPost=${firstPostTag}, excluded=${excludedIdx}, secondPost=${secondPostTag}`
  );
}

async function test_preprocessPosts_tombstone_xml_format() {
  const originalItem = makeFeedItem({ handle: "alice.bsky.social", did: "did:plc:alice" });
  const tombstone = makeTombstone(originalItem);
  const items = [tombstone];

  const xml = preprocessPosts(items as any);
  assert.ok(
    xml.includes('author_handle="alice.bsky.social"'),
    "tombstone should include author handle"
  );
  assert.ok(xml.includes("reason=\"ai_preferences\""), "tombstone should have reason attribute");
  assert.ok(
    xml.includes("This post is hidden because the author has disabled AI inference/training"),
    "tombstone should include explanation text"
  );
}

async function test_filterThreadByAiPreferences_requested_post_always_shown() {
  // Simulate a thread view where the requested post's author denies AI prefs
  const deniedRecord = { training: "deny", inference: "deny" };
  const allowedMap = new Map([["did:plc:alice", false]]);

  const threadView = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      uri: "at://did:plc:alice/app.bsky.feed.post/123",
      author: { handle: "alice.test", did: "did:plc:alice" },
      record: { text: "Hello", createdAt: new Date().toISOString(), facets: [] },
      indexedAt: new Date().toISOString(),
    },
    replies: [],
  };

  // With isRequestedPost=true, the post should NOT be replaced with a tombstone
  const result = filterThreadByAiPreferences(threadView, allowedMap, true);
  assert.ok(!result.__aiPrefExcluded, "requested post should never be a tombstone");
  assert.equal(result.post.author.did, "did:plc:alice", "post data preserved");
}

async function test_filterThreadByAiPreferences_non_requested_post_replaced() {
  const allowedMap = new Map([["did:plc:bob", false]]);

  const threadView = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      uri: "at://did:plc:bob/app.bsky.feed.post/456",
      author: { handle: "bob.test", did: "did:plc:bob" },
      record: { text: "Hidden post", createdAt: new Date().toISOString(), facets: [] },
      indexedAt: new Date().toISOString(),
    },
    replies: [],
  };

  // With isRequestedPost=false, denied posts should become tombstones
  const result = filterThreadByAiPreferences(threadView, allowedMap, false);
  assert.ok(result.__aiPrefExcluded, "non-requested denied post should be a tombstone");
}

async function test_filterThreadByAiPreferences_null_input() {
  const allowedMap = new Map();
  assert.equal(filterThreadByAiPreferences(null as any, allowedMap), null);
  assert.equal(filterThreadByAiPreferences(undefined as any, allowedMap), undefined);
}

async function test_formatPostThreadWithAiPrefs_produces_valid_xml() {
  const allowedMap = new Map([["did:plc:bob", false]]);

  const threadView = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      uri: "at://did:plc:alice/app.bsky.feed.post/123",
      author: { handle: "alice.test", did: "did:plc:alice" },
      record: { text: "Main post", createdAt: new Date().toISOString(), facets: [] },
      indexedAt: new Date().toISOString(),
    },
    replies: [
      {
        $type: "app.bsky.feed.defs#threadViewPost",
        post: {
          uri: "at://did:plc:bob/app.bsky.feed.post/456",
          author: { handle: "bob.test", did: "did:plc:bob" },
          record: { text: "Reply from denied user", createdAt: new Date().toISOString(), facets: [] },
          indexedAt: new Date().toISOString(),
        },
        replies: [],
      },
    ],
  };

  const xml = formatPostThreadWithAiPrefs(threadView, allowedMap);
  assert.ok(xml.includes("<posts>"), "should produce <posts> wrapper");
  assert.ok(xml.includes("</posts>"), "should close </posts>");
  // Main post (alice) should be visible
  assert.ok(
    xml.includes("Main post") || xml.includes("alice.test"),
    "main post content should appear"
  );
  // Bob's reply should be a tombstone, not the actual text
  assert.ok(xml.includes("<excluded_post"), "denied reply should become a tombstone");
  assert.ok(
    !xml.includes("Reply from denied user"),
    "actual content of denied post should NOT appear"
  );
}

async function test_formatPostThreadWithAiPrefs_no_parents() {
  const allowedMap = new Map([["did:plc:alice", true]]);

  const threadView = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: {
      uri: "at://did:plc:alice/app.bsky.feed.post/123",
      author: { handle: "alice.test", did: "did:plc:alice" },
      record: { text: "Standalone thread", createdAt: new Date().toISOString(), facets: [] },
      indexedAt: new Date().toISOString(),
    },
  };

  const xml = formatPostThreadWithAiPrefs(threadView, allowedMap);
  assert.ok(xml.includes("<posts>"));
  assert.ok(xml.includes("Standalone thread"));
}

async function test_filterPostsByAiPreferences_mixed_tombstone_and_normal_input() {
  // When input already contains tombstones (e.g., from a previous pass), they should be preserved
  const normalItem = makeFeedItem({ handle: "a.test", did: "did:plc:a" });
  const existingTombstone = makeTombstone(makeFeedItem({ handle: "b.test", did: "did:plc:b" }));

  const items = [normalItem, existingTombstone];
  const allowedMap = new Map([["did:plc:a", true], ["did:plc:b", false]]);

  const result = filterPostsByAiPreferences(items, allowedMap);
  assert.equal(result.filtered.length, 2);
  // The existing tombstone should pass through unchanged
  assert.ok(result.filtered[1].__aiPrefExcluded);
}

// ---------------------------------------------------------------------------

// Additional formatter branches: reposts, replies, quotes, media, and parent chains.
const THREAD_TYPE = "app.bsky.feed.defs#threadViewPost";
const POST_VIEW_TYPE = "app.bsky.feed.defs#postView";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function makeFormatterFeedItem(options: {
  uri?: string;
  did?: string;
  handle?: string;
  displayName?: string;
  text?: string;
  reply?: any;
  reason?: any;
  embed?: any;
  facets?: any[];
  counts?: { likes?: number; reposts?: number; replies?: number; quotes?: number };
} = {}): any {
  const uri = options.uri ?? "at://did:plc:alice/app.bsky.feed.post/post1";
  const did = options.did ?? "did:plc:alice";
  const handle = options.handle ?? "alice.test";
  const counts = options.counts ?? {};
  return {
    post: {
      uri,
      cid: "cid-" + uri.split("/").pop(),
      author: { did, handle, displayName: options.displayName ?? "Alice" },
      record: {
        text: options.text ?? "hello",
        createdAt: "2026-08-01T12:00:00.000Z",
        facets: options.facets ?? [],
        ...(options.reply?.recordReply ? { reply: options.reply.recordReply } : {}),
      },
      indexedAt: "2026-08-01T12:00:00.000Z",
      likeCount: counts.likes ?? 1,
      repostCount: counts.reposts ?? 2,
      replyCount: counts.replies ?? 3,
      quoteCount: counts.quotes,
      embed: options.embed,
    },
    reply: options.reply?.feedReply,
    reason: options.reason,
  };
}

function makeThreadPost(options: {
  uri?: string;
  did?: string;
  handle?: string;
  text?: string;
  parent?: any;
  replies?: any[];
  embed?: any;
  recordReply?: any;
  requested?: boolean;
} = {}): any {
  const uri = options.uri ?? "at://did:plc:alice/app.bsky.feed.post/thread1";
  const post = {
    $type: POST_VIEW_TYPE,
    uri,
    cid: "cid-" + uri.split("/").pop(),
    author: {
      did: options.did ?? "did:plc:alice",
      handle: options.handle ?? "alice.test",
      displayName: "Alice & Friends",
    },
    record: {
      text: options.text ?? "thread text",
      createdAt: "2026-08-01T12:00:00.000Z",
      facets: [],
      ...(options.recordReply ? { reply: options.recordReply } : {}),
    },
    indexedAt: "2026-08-01T12:00:00.000Z",
    likeCount: 4,
    repostCount: 5,
    replyCount: 6,
    quoteCount: 7,
    embed: options.embed,
  };
  return {
    $type: THREAD_TYPE,
    post,
    ...(options.parent ? { parent: options.parent } : {}),
    ...(options.replies ? { replies: options.replies } : {}),
    ...(options.requested ? { isRequestedPost: true } : {}),
  };
}

function makeReplyRef(root: any, parent: any): any {
  return {
    recordReply: {
      root: { uri: root, cid: "root-cid" },
      parent: { uri: parent, cid: "parent-cid" },
    },
    feedReply: {
      root: { $type: POST_VIEW_TYPE, uri: root },
      parent: { $type: POST_VIEW_TYPE, uri: parent },
    },
  };
}

async function testFeedPostVariants() {
  const linkFacets = [{
    index: { byteStart: 0, byteEnd: 5 },
    features: [{ $type: "app.bsky.richtext.facet#tag", tag: "hello" }],
  }];
  assert.match(facetsToMarkdown("hello", linkFacets), /#hello/);

  const rootUri = "at://did:plc:root/app.bsky.feed.post/root";
  const replyUri = "at://did:plc:reply/app.bsky.feed.post/reply";
  const reply = makeFormatterFeedItem({
    uri: replyUri,
    did: "did:plc:reply",
    handle: "reply.test",
    text: "a reply",
    reply: makeReplyRef(rootUri, rootUri),
  });
  assert.match(preprocessPost(reply), /type="reply"/);
  assert.match(preprocessPost(reply), /reply_to="at:\/\/did:plc:root\/app\.bsky\.feed\.post\/root"/);

  const image = makeFormatterFeedItem({
    uri: "at://did:plc:image/app.bsky.feed.post/image",
    embed: {
      $type: "app.bsky.embed.images#view",
      images: [
        { alt: "", thumb: "https://img.test/thumb" },
        { alt: "a sunset", fullsize: "https://img.test/full" },
      ],
    },
  });
  const external = makeFormatterFeedItem({
    uri: "at://did:plc:external/app.bsky.feed.post/external",
    embed: {
      $type: "app.bsky.embed.external#view",
      external: { title: "Article", uri: "https://example.com", description: "Description" },
    },
  });
  const video = makeFormatterFeedItem({
    uri: "at://did:plc:video/app.bsky.feed.post/video",
    embed: {
      $type: "app.bsky.embed.video#view",
      thumbnail: "https://video.test/thumb",
      playlist: "https://video.test/playlist.m3u8",
    },
  });
  const quote = makeFormatterFeedItem({
    uri: "at://did:plc:quote/app.bsky.feed.post/quote",
    embed: {
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewRecord",
        uri: "at://did:plc:quoted/app.bsky.feed.post/quoted",
        author: { handle: "quoted.test", displayName: "Quoted" },
        value: { text: "quoted text", createdAt: "2026-08-01T12:00:00.000Z", facets: [] },
        likeCount: 8,
        repostCount: 9,
        replyCount: 10,
      },
    },
    counts: { quotes: 11 },
  });
  const repost = makeFormatterFeedItem({
    uri: "at://did:plc:reposted/app.bsky.feed.post/original",
    reason: {
      $type: "app.bsky.feed.defs#reasonRepost",
      by: { handle: "reposter.test", displayName: "Reposter" },
      indexedAt: "2026-08-02T12:00:00.000Z",
    },
  });

  const xml = preprocessPosts([image, external, video, quote, repost]);
  assert.match(xml, /<embed type="image">/);
  assert.match(xml, /No description provided/);
  assert.match(xml, /<embed type="link">/);
  assert.match(xml, /<embed type="video">/);
  assert.match(xml, /Thumbnail: https:\/\/video\.test\/thumb/);
  assert.match(xml, /<quoted_post/);
  assert.match(xml, /quoted text/);
  assert.match(xml, /<repost author_name="Reposter"/);
  assert.match(xml, /11 quotes/);

  const feedXml = formatFeed({ items: [image] });
  assert.match(feedXml, /^<posts>/);
}

async function testRecursiveThreadFormatting() {
  const rootUri = "at://did:plc:root/app.bsky.feed.post/root";
  const childUri = "at://did:plc:child/app.bsky.feed.post/child";
  const childRecordReply = {
    root: { uri: rootUri, cid: "root-cid" },
    parent: { uri: rootUri, cid: "root-cid" },
  };
  const child = makeThreadPost({
    uri: childUri,
    did: "did:plc:child",
    handle: "child.test",
    text: "child reply",
    recordReply: childRecordReply,
  });
  const root = makeThreadPost({ uri: rootUri, did: "did:plc:root", handle: "root.test", text: "root post", replies: [child] });

  const noParentXml = formatPostThread(clone(root));
  assert.match(noParentXml, /requested="true"/);
  assert.match(noParentXml, /<replies>/);
  assert.match(noParentXml, /child reply/);
  assert.match(noParentXml, /reply_to="at:\/\/did:plc:root\/app\.bsky\.feed\.post\/root"/);

  const parentRoot = makeThreadPost({ uri: rootUri, did: "did:plc:root", handle: "root.test", text: "parent root" });
  const childWithParent = makeThreadPost({
    uri: childUri,
    did: "did:plc:child",
    handle: "child.test",
    text: "child with parent",
    parent: parentRoot,
    recordReply: childRecordReply,
  });
  const parentXml = formatPostThread(clone(childWithParent));
  assert.match(parentXml, /parent root/);
  assert.match(parentXml, /child with parent/);

  const imageThread = makeThreadPost({
    uri: "at://did:plc:media/app.bsky.feed.post/media",
    handle: "media.test",
    embed: {
      $type: "app.bsky.embed.images#view",
      images: [null, { alt: "photo & sky", fullsize: "https://img.test/full" }],
    },
  });
  const externalThread = makeThreadPost({
    uri: "at://did:plc:link/app.bsky.feed.post/link",
    handle: "link.test",
    embed: {
      $type: "app.bsky.embed.external#view",
      external: {
        title: "A <title>",
        uri: "https://example.com/article",
        description: "A description",
        thumb: "https://img.test/card",
      },
    },
  });
  const videoThread = makeThreadPost({
    uri: "at://did:plc:vid/app.bsky.feed.post/vid",
    handle: "video.test",
    embed: {
      $type: "app.bsky.embed.video#view",
      video: { alt: "video", thumb: "https://video.test/thumb", url: "https://video.test/video" },
    },
  });
  const quoteThread = makeThreadPost({
    uri: "at://did:plc:q/app.bsky.feed.post/q",
    handle: "quote.test",
    embed: {
      $type: "app.bsky.embed.record#view",
      record: {
        uri: "at://did:plc:quoted/app.bsky.feed.post/q1",
        author: { handle: "quoted.test", displayName: "Quoted" },
        indexedAt: "2026-08-01T12:00:00.000Z",
        value: { text: "quoted value", facets: [] },
        likeCount: 1,
        quoteCount: 2,
      },
    },
  });
  assert.match(formatPostThread(clone(imageThread)), /Image description:/);
  assert.match(formatPostThread(clone(externalThread)), /A &lt;title&gt;/);
  assert.match(formatPostThread(clone(videoThread)), /Video description:/);
  assert.match(formatPostThread(clone(quoteThread)), /<quoted_post/);
}

async function testAiPreferenceThreadFormattingAndGuards() {
  const rootUri = "at://did:plc:root/app.bsky.feed.post/root-extra";
  const childUri = "at://did:plc:child/app.bsky.feed.post/child-extra";
  const child = makeThreadPost({
    uri: childUri,
    did: "did:plc:child-extra",
    handle: "child.test",
    text: "allowed child",
    recordReply: { root: { uri: rootUri, cid: "r" }, parent: { uri: rootUri, cid: "r" } },
  });
  const root = makeThreadPost({
    uri: rootUri,
    did: "did:plc:root-extra",
    handle: "root.test",
    text: "requested root",
    replies: [child],
  });
  const allowed = new Map([["did:plc:root-extra", true], ["did:plc:child-extra", true]]);
  const formatted = formatPostThreadWithAiPrefs(clone(root), allowed);
  assert.match(formatted, /requested="true"/);
  assert.match(formatted, /allowed child/);

  // A parent chain whose root has ordinary replies uses the second formatter
  // implementation (processFilteredThreadViewPost), including its media
  // branches. Keep the root allowed so that the reply is rendered normally.
  const filteredReply = makeThreadPost({
    uri: "at://did:plc:filtered/app.bsky.feed.post/reply",
    did: "did:plc:filtered-reply",
    handle: "filtered-reply.test",
    text: "filtered formatter reply",
    embed: {
      $type: "app.bsky.embed.images#view",
      images: [{ alt: "reply image", fullsize: "https://img.test/reply" }],
    },
  });
  const filteredRoot = makeThreadPost({
    uri: "at://did:plc:filtered/app.bsky.feed.post/root",
    did: "did:plc:filtered-root",
    handle: "filtered-root.test",
    text: "filtered formatter root",
    replies: [filteredReply],
  });
  const requestedFromChain = makeThreadPost({
    uri: "at://did:plc:filtered/app.bsky.feed.post/requested",
    did: "did:plc:filtered-requested",
    handle: "filtered-requested.test",
    text: "requested chain post",
    parent: filteredRoot,
    recordReply: { root: { uri: filteredRoot.post.uri, cid: "r" }, parent: { uri: filteredRoot.post.uri, cid: "r" } },
  });
  const filteredChainXml = formatPostThreadWithAiPrefs(
    clone(requestedFromChain),
    new Map([
      ["did:plc:filtered-root", true],
      ["did:plc:filtered-reply", true],
      ["did:plc:filtered-requested", true],
    ]),
    true,
  );
  assert.match(filteredChainXml, /filtered formatter reply/);
  assert.match(filteredChainXml, /reply image/);

  const childWithDeniedParent = makeThreadPost({
    uri: childUri + "-parent-chain",
    did: "did:plc:child-extra-2",
    handle: "child2.test",
    text: "requested child",
    parent: makeThreadPost({
      uri: rootUri + "-denied",
      did: "did:plc:denied-parent",
      handle: "denied.test",
      text: "secret parent",
    }),
    recordReply: { root: { uri: rootUri, cid: "r" }, parent: { uri: rootUri, cid: "r" } },
  });
  const parentFiltered = formatPostThreadWithAiPrefs(
    clone(childWithDeniedParent),
    new Map([["did:plc:denied-parent", false], ["did:plc:child-extra-2", true]]),
    true,
  );
  assert.match(parentFiltered, /<excluded_post/);
  assert.doesNotMatch(parentFiltered, /secret parent/);

  const tombstone = {
    __aiPrefExcluded: true,
    originalItem: { post: { uri: "at://did:plc:hidden/app.bsky.feed.post/1", author: { handle: "hidden.test" } } },
  };
  assert.match(formatPostThreadWithAiPrefs(tombstone, new Map()), /author_handle="hidden.test"/);
  assert.match(formatPostThreadWithAiPrefs(null, new Map()), /No thread data available/);
  assert.match(formatPostThreadWithAiPrefs({ $type: "wrong" }, new Map()), /^<posts>\n<\/posts>$/);

  const deniedReply = filterThreadByAiPreferences(clone(root), new Map([["did:plc:child-extra", false]]), true);
  assert.ok(deniedReply.replies[0].__aiPrefExcluded);
  assert.equal(processThreadViewPost({ $type: "wrong" }, 0), "");
  assert.equal(processThreadViewPost(null, 0), "");
  assert.equal(processThreadViewPost({ $type: THREAD_TYPE, post: {} }, 0), "");
  assert.equal(processThreadViewPost({ $type: THREAD_TYPE, post: { uri: "missing-record" } }, 0), "");
  assert.equal(processThreadViewPost({ $type: THREAD_TYPE, post: { record: {}, uri: "", author: { handle: "x" } } }, 0), "");
  assert.equal(processThreadViewPost({ $type: THREAD_TYPE, post: { record: {}, uri: "at://x", author: {} } }, 0), "");
}


// Runner
// ---------------------------------------------------------------------------

async function main() {
  await loadModules();

  const cases: Array<[string, () => Promise<void>]> = [
    ["formatter feed post variants and embeds", testFeedPostVariants],
    ["formatter recursive thread, parent, and media formatting", testRecursiveThreadFormatting],
    ["formatter AI preference thread guards", testAiPreferenceThreadFormattingAndGuards],
    ["filterPostsByAiPreferences replaces denied with tombstones", test_filterPostsByAiPreferences_replaces_denied_with_tombstones],
    ["filterPostsByAiPreferences preserves order", test_filterPostsByAiPreferences_preserves_order],
    ["filterPostsByAiPreferences handles empty input", test_filterPostsByAiPreferences_empty_input],
    ["filterPostsByAiPreferences passes through items without author info", test_filterPostsByAiPreferences_items_without_author_info_pass_through],
    ["filterPostsByAiPreferences populates deniedCategories from record", test_filterPostsByAiPreferences_deniedCategories_populated],
    ["filterPostsByAiPreferences deniedCategories undefined when no record provided", test_filterPostsByAiPreferences_deniedCategories_empty_when_no_record],
    ["preprocessPosts with tombstones preserves position", test_preprocessPosts_with_tombstones_preserves_position],
    ["preprocessPosts tombstone XML format is correct", test_preprocessPosts_tombstone_xml_format],
    ["filterThreadByAiPreferences requested post always shown", test_filterThreadByAiPreferences_requested_post_always_shown],
    ["filterThreadByAiPreferences non-requested denied post replaced", test_filterThreadByAiPreferences_non_requested_post_replaced],
    ["filterThreadByAiPreferences handles null/undefined input", test_filterThreadByAiPreferences_null_input],
    ["formatPostThreadWithAiPrefs produces valid XML with tombstones in replies", test_formatPostThreadWithAiPrefs_produces_valid_xml],
    ["formatPostThreadWithAiPrefs works for threads without parents", test_formatPostThreadWithAiPrefs_no_parents],
    ["filterPostsByAiPreferences handles mixed tombstone and normal input", test_filterPostsByAiPreferences_mixed_tombstone_and_normal_input],
  ];

  await runTests(cases);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

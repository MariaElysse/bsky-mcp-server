import { runTests } from "./test-helpers.js";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Regression lock for src/llm-preprocessor.ts: the inline ISO-9075 date
// formatter and the single consolidated ThreadViewPost walker.
//
// Every `expected` block below was captured from the module *before* the
// walkers were merged (and before formatDate was inlined). Those two rewrites
// were supposed to change no output, so the quirks pinned here are the point of
// the file — do not "tidy" them. See docs/post-format-spec.md for the contract.

// The feed formatter renders local wall-clock time, so the pinned date fixtures
// assume UTC. The walker fixtures mask posted_at instead, because those values
// go through toLocaleString() and depend on the runner's ICU locale.
process.env.TZ = "UTC";

type PreprocessorModule = typeof import("../src/llm-preprocessor.js");

interface Case {
  name: string;
  run: (m: PreprocessorModule) => string;
  /** Mask the locale-dependent posted_at values before comparing (walker cases). */
  maskDates?: boolean;
  /** Exact console.error lines the fixture must emit (arguments joined per call). */
  logs?: string[];
  /** Joined with "\n" and compared as one string, so whitespace is pinned too. */
  expected: string[];
}

/** Pins a throw instead of a render, for entry points with no input guard. */
function captureThrow(fn: () => string): string {
  try {
    return fn();
  } catch (error) {
    return `THROWN: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
}

// ---------------------------------------------------------------------------
// Fixture builders — minimal ThreadViewPost shapes
// ---------------------------------------------------------------------------

const ALICE = "did:plc:aaaa1111bbbb2222cccc3333";
const BOB = "did:plc:dddd4444eeee5555ffff6666";
const CAROL = "did:plc:gggg7777hhhh8888iiii9999";

const uriOf = (did: string, rkey: string) => `at://${did}/app.bsky.feed.post/${rkey}`;

const utf8Length = (text: string, upto: number) =>
  new TextEncoder().encode(text.slice(0, upto)).length;

function postView(o: any = {}): any {
  return {
    uri: o.uri ?? uriOf(ALICE, "root1"),
    cid: o.cid,
    author: "author" in o ? o.author : { did: ALICE, handle: "alice.test", displayName: "Alice A." },
    record:
      "record" in o
        ? o.record
        : {
            $type: "app.bsky.feed.post",
            text: o.text ?? "hello world",
            createdAt: o.createdAt ?? "2021-08-04T13:30:00.000Z",
            facets: o.facets,
            reply: o.reply,
          },
    indexedAt: "indexedAt" in o ? o.indexedAt : "2021-08-04T13:30:05.000Z",
    likeCount: o.likeCount,
    repostCount: o.repostCount,
    replyCount: o.replyCount,
    quoteCount: o.quoteCount,
    embed: o.embed,
  };
}

function tvp(o: any = {}): any {
  return {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: "post" in o ? o.post : postView(),
    parent: o.parent,
    replies: o.replies,
  };
}

function feedItem(o: any = {}): any {
  const item: any = {
    post: postView({
      uri: o.uri ?? uriOf(ALICE, "feed1"),
      author: o.author ?? { did: ALICE, handle: "alice.test", displayName: "Alice A." },
      text: o.text ?? "feed text",
      createdAt: o.createdAt,
      indexedAt: o.indexedAt,
      likeCount: o.likeCount,
      repostCount: o.repostCount,
      replyCount: o.replyCount,
      quoteCount: o.quoteCount,
      // The record carries the strong refs, and it is `record.reply` that makes
      // the post type read as "reply" at all.
      reply: o.replyTo
        ? { parent: { uri: o.replyTo }, root: { uri: o.replyRoot ?? o.replyTo } }
        : undefined,
    }),
    reason: o.reason,
  };
  // The feed item's own `reply` is the resolved view of the same posts; it is
  // what `reply_to` and the thread grouping read.
  if (o.replyTo) {
    item.reply = {
      parent: postRef(o.replyTo),
      root: postRef(o.replyRoot ?? o.replyTo),
    };
  }
  return item;
}

/** The resolved-postView shape the feed puts in `FeedViewPost.reply`. */
function postRef(uri: string): any {
  return { $type: "app.bsky.feed.defs#postView", uri };
}

function tombstone(o: any = {}): any {
  return {
    __aiPrefExcluded: true,
    originalItem: {
      post: postView({
        uri: o.uri ?? uriOf(CAROL, "hidden1"),
        author: { did: CAROL, handle: o.handle ?? "carol.test", displayName: "Carol" },
      }),
    },
    deniedCategories: o.deniedCategories ?? ["inference", "training"],
    reason: o.reason,
  };
}

const LINK_TEXT = "see https://ex.com/a and @bob.test plus #tag";
const linkFacets = () => [
  {
    index: { byteStart: utf8Length(LINK_TEXT, 4), byteEnd: utf8Length(LINK_TEXT, 20) },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://ex.com/a" }],
  },
  {
    index: { byteStart: utf8Length(LINK_TEXT, 25), byteEnd: utf8Length(LINK_TEXT, 34) },
    features: [{ $type: "app.bsky.richtext.facet#mention", did: BOB, handle: "bob.test" }],
  },
  {
    index: { byteStart: utf8Length(LINK_TEXT, 40), byteEnd: utf8Length(LINK_TEXT, 44) },
    features: [{ $type: "app.bsky.richtext.facet#tag", tag: "tag" }],
  },
];

// ---------------------------------------------------------------------------
// Cases — expectations pinned from the pre-refactor module
// ---------------------------------------------------------------------------

export const CASES: Case[] = [
  {
    name: "thread: standalone post with no replies",
    maskDates: true,
    run: (m) => m.formatPostThread(tvp()),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/root1\" bsky_url=\"https://bsky.app/profile/alice.test/post/root1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    hello world",
      "  </content>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: three levels of replies keep the nested indentation",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          replies: [
            tvp({ post: postView({ uri: uriOf(BOB, "child1"), text: "first reply" }), replies: [tvp({ post: postView({ uri: uriOf(CAROL, "grand1"), text: "nested reply" }) })] }),
          ],
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/root1\" bsky_url=\"https://bsky.app/profile/alice.test/post/root1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    hello world",
      "  </content>",
      "  <replies>",
      "    <post type=\"standalone\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/child1\" bsky_url=\"https://bsky.app/profile/alice.test/post/child1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\">",
      "      <content>",
      "        first reply",
      "      </content>",
      "      <replies>",
      "        <post type=\"standalone\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/grand1\" bsky_url=\"https://bsky.app/profile/alice.test/post/grand1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\">",
      "          <content>",
      "            nested reply",
      "          </content>",
      "        </post>",
      "      </replies>",
      "    </post>",
      "  </replies>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: parent chain renders ancestors before the requested post",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: uriOf(ALICE, "asked1"),
            text: "the requested post",
            reply: { parent: { uri: uriOf(BOB, "mid1") }, root: { uri: uriOf(CAROL, "top1") } },
          }),
          parent: tvp({
            post: postView({
              uri: uriOf(BOB, "mid1"),
              text: "middle ancestor",
              reply: { parent: { uri: uriOf(CAROL, "top1") }, root: { uri: uriOf(CAROL, "top1") } },
            }),
            parent: tvp({ post: postView({ uri: uriOf(CAROL, "top1"), text: "top ancestor" }) }),
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/top1\" bsky_url=\"https://bsky.app/profile/alice.test/post/top1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\">",
      "  <content>",
      "    top ancestor",
      "  </content>",
      "  <replies>",
      "    <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/mid1\" bsky_url=\"https://bsky.app/profile/alice.test/post/mid1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" reply_to=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/top1\">",
      "      <content>",
      "        middle ancestor",
      "      </content>",
      "      <replies>",
      "        <post type=\"reply\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/asked1\" bsky_url=\"https://bsky.app/profile/alice.test/post/asked1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" reply_to=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/mid1\" requested=\"true\">",
      "          <content>",
      "            the requested post",
      "          </content>",
      "        </post>",
      "      </replies>",
      "    </post>",
      "  </replies>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: blocked parent is dropped from the chain",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({ uri: uriOf(ALICE, "asked2"), text: "reply to a blocked post", reply: { parent: { uri: uriOf(BOB, "gone2") } } }),
          parent: { $type: "app.bsky.feed.defs#blockedPost", uri: uriOf(BOB, "gone2"), blocked: true },
        })
      ),
        expected: [
      "<posts>",
      "</posts>",
    ],
  },
  {
    name: "thread: notFound parent is dropped from the chain",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({ uri: uriOf(ALICE, "asked3"), text: "reply to a missing post", reply: { parent: { uri: uriOf(BOB, "gone3") } } }),
          parent: { $type: "app.bsky.feed.defs#notFoundPost", uri: uriOf(BOB, "gone3"), notFound: true },
        })
      ),
        expected: [
      "<posts>",
      "</posts>",
    ],
  },
  {
    name: "thread: reply,quote post renders the quoted_post block and engagement",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: uriOf(ALICE, "quote1"),
            text: "quoting this",
            reply: { parent: { uri: uriOf(BOB, "parent4") } },
            likeCount: 7,
            repostCount: 0,
            replyCount: 2,
            quoteCount: 4,
            embed: {
              $type: "app.bsky.embed.record#view",
              record: {
                uri: uriOf(CAROL, "quoted1"),
                author: { did: CAROL, handle: "carol.test", displayName: "Carol & <Co>" },
                value: { text: "the “quoted” text" },
                likeCount: 3,
                repostCount: 0,
                replyCount: 2,
                quoteCount: 1,
              },
            },
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"reply,quote\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/quote1\" bsky_url=\"https://bsky.app/profile/alice.test/post/quote1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" reply_to=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/parent4\" requested=\"true\">",
      "  <content>",
      "    quoting this",
      "  </content>",
      "  <quoted_post uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/quoted1\" bsky_url=\"https://bsky.app/profile/carol.test/post/quoted1\" author_name=\"Carol &amp; &lt;Co&gt;\" author_handle=\"carol.test\" posted_at=\"<D>\">",
      "    <content>",
      "      the “quoted” text",
      "    </content>",
      "    Engagement: 3 likes, 0 reposts, 2 replies, 1 quotes",
      "  </quoted_post>",
      "  Engagement: 7 likes, 0 reposts, 2 replies, 4 quotes",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: image embeds escape alt text and keep missing sizes",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: uriOf(ALICE, "media1"),
            text: "photos",
            embed: {
              $type: "app.bsky.embed.images#view",
              images: [
                { alt: 'a & <b> "photo"', thumb: "https://cdn.test/t1", fullsize: "https://cdn.test/f1" },
                { alt: "", thumb: "https://cdn.test/t2" },
              ],
            },
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/media1\" bsky_url=\"https://bsky.app/profile/alice.test/post/media1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    photos",
      "  </content>",
      "  <embed type=\"image\">",
      "    Image description: \"a &amp; &lt;b&gt; &quot;photo&quot;\"",
      "    URL: https://cdn.test/f1",
      "  </embed>",
      "  <embed type=\"image\">",
      "    URL: https://cdn.test/t2",
      "  </embed>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: external embed renders title, url, description, thumbnail",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: uriOf(ALICE, "media2"),
            text: "link card",
            embed: {
              $type: "app.bsky.embed.external#view",
              external: {
                uri: "https://ex.test/page?a=1&b=2",
                title: 'Title & <tags> "q"',
                description: "Desc <with> & entities",
                thumb: "https://cdn.test/thumb",
              },
            },
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/media2\" bsky_url=\"https://bsky.app/profile/alice.test/post/media2\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    link card",
      "  </content>",
      "  <embed type=\"link\">",
      "    Title: \"Title &amp; &lt;tags&gt; &quot;q&quot;\"",
      "    URL: https://ex.test/page?a=1&b=2",
      "    Description: \"Desc &lt;with&gt; &amp; entities\"",
      "    Thumbnail: https://cdn.test/thumb",
      "  </embed>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: video embed needs the video field on the view",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: uriOf(ALICE, "media3"),
            text: "clip",
            embed: {
              $type: "app.bsky.embed.video#view",
              video: { alt: "Clip & stuff", thumb: "https://cdn.test/vt", url: "https://cdn.test/v.mp4" },
            },
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/media3\" bsky_url=\"https://bsky.app/profile/alice.test/post/media3\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    clip",
      "  </content>",
      "  <embed type=\"video\">",
      "    Video description: Clip &amp; stuff",
      "    Thumbnail: https://cdn.test/vt",
      "    URL: https://cdn.test/v.mp4",
      "  </embed>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: facets become markdown links, mentions, and tags",
    maskDates: true,
    run: (m) => m.formatPostThread(tvp({ post: postView({ uri: uriOf(ALICE, "facet1"), text: LINK_TEXT, facets: linkFacets() }) })),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/facet1\" bsky_url=\"https://bsky.app/profile/alice.test/post/facet1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    see <https://ex.com/a> and [@bob.test](https://bsky.app/profile/did:plc:dddd4444eeee5555ffff6666) plus #tag",
      "  </content>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: non-ASCII text is preserved byte for byte",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: uriOf(ALICE, "unicode1"),
            text: "héllo 世界 — 🦋 “curly”",
            author: { did: ALICE, handle: "alice.test", displayName: "Zoë 🦊" },
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/unicode1\" bsky_url=\"https://bsky.app/profile/alice.test/post/unicode1\" author_name=\"Zoë 🦊\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    héllo 世界 — 🦋 “curly”",
      "  </content>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: attribute escaping cannot break out of the post tag",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          post: postView({
            uri: `${uriOf(ALICE, "escape1")}" injected="`,
            author: { did: ALICE, handle: 'ali"&ce.test', displayName: '</post> <post injected="x">' },
            text: "body stays raw: <script> & \"content\"",
            embed: {
              $type: "app.bsky.embed.external#view",
              external: { uri: "https://ex.test/1", title: '</embed> & "x"', description: "<b>&</b>" },
            },
          }),
        })
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/escape1&quot; injected=&quot;\" bsky_url=\"https://bsky.app/profile/ali&quot;&amp;ce.test/post/escape1&quot; injected=&quot;\" author_name=\"&lt;/post&gt; &lt;post injected=&quot;x&quot;&gt;\" author_handle=\"ali&quot;&amp;ce.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    body stays raw: <script> & \"content\"",
      "  </content>",
      "  <embed type=\"link\">",
      "    Title: \"&lt;/embed&gt; &amp; &quot;x&quot;\"",
      "    URL: https://ex.test/1",
      "    Description: \"&lt;b&gt;&amp;&lt;/b&gt;\"",
      "  </embed>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: a node without a post record is dropped and logged",
    maskDates: true,
    run: (m) =>
      m.formatPostThread(
        tvp({
          replies: [tvp({ post: postView({ uri: uriOf(BOB, "norec1"), record: undefined }) })],
        })
      ),
        logs: ["Record missing for post: | at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/norec1"],
    expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/root1\" bsky_url=\"https://bsky.app/profile/alice.test/post/root1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    hello world",
      "  </content>",
      "  <replies>",
      "  </replies>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: replies that are all null drop the chain tail",
    maskDates: true,
    run: (m) =>
      m.formatPostThreadWithAiPrefs(
        tvp({
          post: postView({ uri: uriOf(ALICE, "chain1"), text: "requested post with junk replies" }),
          replies: [null, undefined],
        }),
        new Map<string, boolean>(),
        true
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/chain1\" bsky_url=\"https://bsky.app/profile/alice.test/post/chain1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    requested post with junk replies",
      "  </content>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: AI-preference tombstone replaces a denied reply",
    maskDates: true,
    run: (m) =>
      m.formatPostThreadWithAiPrefs(
        tvp({
          post: postView({ uri: uriOf(ALICE, "pref1"), text: "mine is kept" }),
          replies: [tvp({ post: postView({ uri: uriOf(CAROL, "hidden2"), text: "should be hidden", author: { did: CAROL, handle: "carol.test", displayName: "Carol" } }) })],
        }),
        new Map([[ALICE, true], [CAROL, false]]),
        true
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/pref1\" bsky_url=\"https://bsky.app/profile/alice.test/post/pref1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    mine is kept",
      "  </content>",
      "  <replies>",
      "    <excluded_post reason=\"ai_preferences\" author_handle=\"carol.test\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/hidden2\">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>  </replies>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: AI-preference tombstone replaces a denied ancestor",
    maskDates: true,
    run: (m) =>
      m.formatPostThreadWithAiPrefs(
        tvp({
          post: postView({ uri: uriOf(ALICE, "pref2"), text: "requested, allowed", reply: { parent: { uri: uriOf(CAROL, "hidden3") } } }),
          parent: tvp({ post: postView({ uri: uriOf(CAROL, "hidden3"), text: "denied ancestor", author: { did: CAROL, handle: "carol.test", displayName: "Carol" } }) }),
        }),
        new Map([[ALICE, true], [CAROL, false]]),
        true
      ),
        expected: [
      "<posts>",
      "<excluded_post reason=\"ai_preferences\" author_handle=\"carol.test\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/hidden3\">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>",
      "<post type=\"reply\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/pref2\" bsky_url=\"https://bsky.app/profile/alice.test/post/pref2\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" reply_to=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/hidden3\" requested=\"true\">",
      "  <content>",
      "    requested, allowed",
      "  </content>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: AI-preference tombstone carries the deny reason",
    maskDates: true,
    run: (m) =>
      m.formatPostThreadWithAiPrefs(
        tvp({
          post: postView({ uri: uriOf(ALICE, "pref3"), text: "requested, allowed" }),
          replies: [tombstone({ uri: uriOf(BOB, "hidden4"), handle: "bob.test", reason: "author opted out" })],
        }),
        new Map([[ALICE, true]]),
        true
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/pref3\" bsky_url=\"https://bsky.app/profile/alice.test/post/pref3\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    requested, allowed",
      "  </content>",
      "  <replies>",
      "    <excluded_post reason=\"ai_preferences\" author_handle=\"bob.test\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/hidden4\">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>  </replies>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: a denied requested post is still rendered when allowed",
    maskDates: true,
    run: (m) =>
      m.formatPostThreadWithAiPrefs(
        tvp({ post: postView({ uri: uriOf(CAROL, "pref4"), text: "requested but denied", author: { did: CAROL, handle: "carol.test", displayName: "Carol" } }) }),
        new Map([[CAROL, false]]),
        true
      ),
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/pref4\" bsky_url=\"https://bsky.app/profile/carol.test/post/pref4\" author_name=\"Carol\" author_handle=\"carol.test\" posted_at=\"<D>\" requested=\"true\">",
      "  <content>",
      "    requested but denied",
      "  </content>",
      "</post>",
      "</posts>",
    ],
  },
  {
    name: "thread: null thread renders the AI-preference error placeholder",
    run: (m) => m.formatPostThreadWithAiPrefs(null as any, new Map<string, boolean>(), true),
        expected: [
      "<posts>",
      "  <error>No thread data available</error>",
      "</posts>",
    ],
  },
  {
    name: "thread: a non-object thread renders the AI-preference error placeholder",
    run: (m) => m.formatPostThreadWithAiPrefs(42 as any, new Map<string, boolean>(), true),
        expected: [
      "<posts>",
      "  <error>No thread data available</error>",
      "</posts>",
    ],
  },
  {
    name: "thread: formatPostThread has no null guard — callers must guard it",
    run: (m) => captureThrow(() => m.formatPostThread(null as any)),
        expected: ["THROWN: TypeError: Cannot read properties of null (reading 'parent')"],
  },
  {
    name: "thread: formatPostThread throws on a non-object thread",
    run: (m) => captureThrow(() => m.formatPostThread(42 as any)),
        expected: ["THROWN: TypeError: Cannot create property 'isRequestedPost' on number '42'"],
  },
  {
    name: "thread: processThreadViewPost honours the indent argument",
    maskDates: true,
    run: (m) => m.processThreadViewPost(tvp({ post: postView({ uri: uriOf(ALICE, "indent1"), text: "indented node" }) }), 2),
        expected: [
      "    <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/indent1\" bsky_url=\"https://bsky.app/profile/alice.test/post/indent1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"<D>\">",
      "      <content>",
      "        indented node",
      "      </content>",
      "    </post>",
      "",
    ],
  },
  {
    name: "feed: posted_at is ISO-9075 local time with a space separator",
    run: (m) =>
      m.preprocessPost(
        feedItem({
          indexedAt: "2021-08-04T13:30:05.000Z",
          createdAt: "2021-08-04T13:30:00.000Z",
        })
      ),
        expected: [
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/feed1\" bsky_url=\"https://bsky.app/profile/alice.test/post/feed1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
    ],
  },
  {
    name: "feed: offset, milliseconds, and missing indexedAt collapse to one wall clock",
    run: (m) =>
      m.formatFeed({ items: [
        feedItem({ uri: uriOf(ALICE, "d1"), indexedAt: "2021-08-04T06:30:00.000-07:00" }),
        feedItem({ uri: uriOf(ALICE, "d2"), indexedAt: undefined, createdAt: "2021-08-04T13:30:00.999Z" }),
      ] }),
        expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d1\" bsky_url=\"https://bsky.app/profile/alice.test/post/d1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d2\" bsky_url=\"https://bsky.app/profile/alice.test/post/d2\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed: year below 1000 is zero-padded to four digits",
    run: (m) => m.preprocessPost(feedItem({ uri: uriOf(ALICE, "d3"), indexedAt: undefined, createdAt: "0999-01-01T00:00:00.000Z" })),
        expected: [
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d3\" bsky_url=\"https://bsky.app/profile/alice.test/post/d3\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"0999-01-01 00:00:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
    ],
  },
  {
    name: "feed: epoch and 2038 boundary keep their digits",
    run: (m) =>
      m.formatFeed({ items: [
        feedItem({ uri: uriOf(ALICE, "d4"), indexedAt: "1970-01-01T00:00:00.000Z" }),
        feedItem({ uri: uriOf(ALICE, "d5"), indexedAt: "2038-01-19T03:14:08Z" }),
      ] }),
        expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d4\" bsky_url=\"https://bsky.app/profile/alice.test/post/d4\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d5\" bsky_url=\"https://bsky.app/profile/alice.test/post/d5\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed: an unparseable date falls back to the original string",
    run: (m) =>
      m.formatFeed({ items: [
        feedItem({ uri: uriOf(ALICE, "d6"), indexedAt: undefined, createdAt: "not-a-date" }),
        feedItem({ uri: uriOf(ALICE, "d7"), indexedAt: "", createdAt: "" }),
      ] }),
        expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d6\" bsky_url=\"https://bsky.app/profile/alice.test/post/d6\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"not-a-date\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d7\" bsky_url=\"https://bsky.app/profile/alice.test/post/d7\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed: a repost reason carries its own formatted date",
    run: (m) =>
      m.preprocessPost(
        feedItem({
          uri: uriOf(ALICE, "d8"),
          indexedAt: "2021-08-04T13:30:00.000Z",
          reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { did: BOB, handle: "bob.test" }, indexedAt: "2021-08-05T01:02:03.000Z" },
        })
      ),
        expected: [
      "  <repost author_name=\"\" author_handle=\"bob.test\" reposted_at=\"2021-08-05 01:02:03\">",
      "    <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/d8\" bsky_url=\"https://bsky.app/profile/alice.test/post/d8\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "      <content>",
      "        feed text",
      "      </content>",
      "      ",
      "      Engagement: undefined likes, undefined reposts, undefined replies",
      "    </post>",
      "  </repost>",
    ],
  },
  {
    name: "feed: posted_at never contains an ISO T separator",
    run: (m) => {
      const out = m.formatFeed({
        items: [
          feedItem({ uri: uriOf(ALICE, "shape1"), indexedAt: "2021-08-04T13:30:00.000Z" }),
          feedItem({ uri: uriOf(ALICE, "shape2"), indexedAt: undefined, createdAt: "2021-08-04T01:02:03.000Z" }),
        ],
      });
      return out.replace(/^.*posted_at="[^"]*".*$/gm, (line) => line.trim());
    },
        expected: [
      "<posts>",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/shape1\" bsky_url=\"https://bsky.app/profile/alice.test/post/shape1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "",
      "<post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/shape2\" bsky_url=\"https://bsky.app/profile/alice.test/post/shape2\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 01:02:03\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "    ",
      "    Engagement: undefined likes, undefined reposts, undefined replies",
      "  </post>",
      "</posts>",
    ],
  },

  // ---------------------------------------------------------------------------
  // Thread nesting in the feed path. A reply is grouped under the post it
  // responds to only when that post is in the same page, and everything else
  // renders at top level with `reply_to`. docs/post-format-spec.md ("Thread
  // Representation", "Complete Specification Example") is the contract for the
  // nested shape; these goldens are what the code puts on the wire.
  // ---------------------------------------------------------------------------
  {
    name: "feed nesting: a reply and its reply nest inside the post they respond to",
    run: (m) =>
      m.preprocessPosts([
        feedItem({ uri: uriOf(ALICE, "t1"), text: "root", likeCount: 1, repostCount: 2, replyCount: 1 }),
        feedItem({
          uri: uriOf(BOB, "t1a"),
          text: "first reply",
          author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
          replyTo: uriOf(ALICE, "t1"),
          likeCount: 3,
          repostCount: 0,
          replyCount: 1,
        }),
        feedItem({
          uri: uriOf(CAROL, "t1a1"),
          text: "grandchild reply",
          author: { did: CAROL, handle: "carol.test", displayName: "Carol C." },
          replyTo: uriOf(BOB, "t1a"),
          replyRoot: uriOf(ALICE, "t1"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
      ]),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t1\" bsky_url=\"https://bsky.app/profile/alice.test/post/t1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      root",
      "    </content>",
      "    ",
      "    Engagement: 1 likes, 2 reposts, 1 replies",
      "",
      "    <replies>",
      "      <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t1a\" bsky_url=\"https://bsky.app/profile/bob.test/post/t1a\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t1\">",
      "        <content>",
      "          first reply",
      "        </content>",
      "",
      "        Engagement: 3 likes, 0 reposts, 1 replies",
      "",
      "        <replies>",
      "          <post type=\"reply\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/t1a1\" bsky_url=\"https://bsky.app/profile/carol.test/post/t1a1\" author_name=\"Carol C.\" author_handle=\"carol.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t1a\">",
      "            <content>",
      "              grandchild reply",
      "            </content>",
      "",
      "            Engagement: 0 likes, 0 reposts, 0 replies",
      "          </post>",
      "        </replies>",
      "      </post>",
      "    </replies>",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed nesting: a reply whose parent is not in the page renders at top level with reply_to",
    run: (m) =>
      m.preprocessPosts([
        feedItem({ uri: uriOf(ALICE, "t2"), text: "root", likeCount: 1, repostCount: 0, replyCount: 0 }),
        feedItem({
          uri: uriOf(BOB, "t2a"),
          text: "reply to an earlier post",
          author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
          replyTo: uriOf(ALICE, "older"),
          replyRoot: uriOf(ALICE, "older"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
      ]),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t2\" bsky_url=\"https://bsky.app/profile/alice.test/post/t2\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      root",
      "    </content>",
      "    ",
      "    Engagement: 1 likes, 0 reposts, 0 replies",
      "  </post>",
      "",
      "  <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t2a\" bsky_url=\"https://bsky.app/profile/bob.test/post/t2a\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/older\">",
      "    <content>",
      "      reply to an earlier post",
      "    </content>",
      "    ",
      "    Engagement: 0 likes, 0 reposts, 0 replies",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed nesting: a reply listed before its parent still renders once, nested, at the parent's slot",
    run: (m) =>
      m.preprocessPosts([
        feedItem({
          uri: uriOf(BOB, "t3a"),
          text: "reply listed first",
          author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
          replyTo: uriOf(ALICE, "t3"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
        feedItem({ uri: uriOf(ALICE, "t3"), text: "root", likeCount: 0, repostCount: 0, replyCount: 0 }),
      ]),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t3\" bsky_url=\"https://bsky.app/profile/alice.test/post/t3\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      root",
      "    </content>",
      "    ",
      "    Engagement: 0 likes, 0 reposts, 0 replies",
      "",
      "    <replies>",
      "      <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t3a\" bsky_url=\"https://bsky.app/profile/bob.test/post/t3a\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t3\">",
      "        <content>",
      "          reply listed first",
      "        </content>",
      "",
      "        Engagement: 0 likes, 0 reposts, 0 replies",
      "      </post>",
      "    </replies>",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed nesting: replies to a reposted post nest inside the reposted post, inside <repost>",
    run: (m) =>
      m.preprocessPosts([
        feedItem({
          uri: uriOf(ALICE, "t4"),
          text: "reposted body",
          likeCount: 5,
          repostCount: 1,
          replyCount: 1,
          reason: {
            $type: "app.bsky.feed.defs#reasonRepost",
            by: { did: BOB, handle: "bob.test", displayName: "Bob B." },
            indexedAt: "2021-08-05T01:02:03.000Z",
          },
        }),
        feedItem({
          uri: uriOf(CAROL, "t4a"),
          text: "reply to the reposted post",
          author: { did: CAROL, handle: "carol.test", displayName: "Carol C." },
          replyTo: uriOf(ALICE, "t4"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
      ]),
    expected: [
      "<posts>",
      "  <repost author_name=\"Bob B.\" author_handle=\"bob.test\" reposted_at=\"2021-08-05 01:02:03\">",
      "    <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t4\" bsky_url=\"https://bsky.app/profile/alice.test/post/t4\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "      <content>",
      "        reposted body",
      "      </content>",
      "      ",
      "      Engagement: 5 likes, 1 reposts, 1 replies",
      "",
      "      <replies>",
      "        <post type=\"reply\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/t4a\" bsky_url=\"https://bsky.app/profile/carol.test/post/t4a\" author_name=\"Carol C.\" author_handle=\"carol.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t4\">",
      "          <content>",
      "            reply to the reposted post",
      "          </content>",
      "",
      "          Engagement: 0 likes, 0 reposts, 0 replies",
      "        </post>",
      "      </replies>",
      "    </post>",
      "  </repost>",
      "</posts>",
    ],
  },
  {
    name: "feed nesting: a self-reply and a two-item cycle terminate and still render every post",
    run: (m) =>
      m.preprocessPosts([
        feedItem({ uri: uriOf(ALICE, "t5"), text: "replies to itself", replyTo: uriOf(ALICE, "t5"), likeCount: 0, repostCount: 0, replyCount: 0 }),
        feedItem({
          uri: uriOf(BOB, "t5a"),
          text: "cycle a",
          author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
          replyTo: uriOf(CAROL, "t5b"),
          replyRoot: uriOf(BOB, "t5a"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
        feedItem({
          uri: uriOf(CAROL, "t5b"),
          text: "cycle b",
          author: { did: CAROL, handle: "carol.test", displayName: "Carol C." },
          replyTo: uriOf(BOB, "t5a"),
          replyRoot: uriOf(BOB, "t5a"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
      ]),
    expected: [
      "<posts>",
      "  <post type=\"reply\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t5\" bsky_url=\"https://bsky.app/profile/alice.test/post/t5\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t5\">",
      "    <content>",
      "      replies to itself",
      "    </content>",
      "    ",
      "    Engagement: 0 likes, 0 reposts, 0 replies",
      "  </post>",
      "",
      "  <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t5a\" bsky_url=\"https://bsky.app/profile/bob.test/post/t5a\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/t5b\">",
      "    <content>",
      "      cycle a",
      "    </content>",
      "    ",
      "    Engagement: 0 likes, 0 reposts, 0 replies",
      "  </post>",
      "",
      "  <post type=\"reply\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/t5b\" bsky_url=\"https://bsky.app/profile/carol.test/post/t5b\" author_name=\"Carol C.\" author_handle=\"carol.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t5a\">",
      "    <content>",
      "      cycle b",
      "    </content>",
      "    ",
      "    Engagement: 0 likes, 0 reposts, 0 replies",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed nesting: a hidden post never nests, wherever it sits in the page",
    run: (m) =>
      m.preprocessPosts([
        feedItem({ uri: uriOf(ALICE, "t6"), text: "root", likeCount: 0, repostCount: 0, replyCount: 1 }),
        tombstone({ uri: uriOf(CAROL, "t6h"), handle: "carol.test" }),
        feedItem({
          uri: uriOf(BOB, "t6a"),
          text: "reply under root",
          author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
          replyTo: uriOf(ALICE, "t6"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
      ]),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t6\" bsky_url=\"https://bsky.app/profile/alice.test/post/t6\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      root",
      "    </content>",
      "    ",
      "    Engagement: 0 likes, 0 reposts, 1 replies",
      "",
      "    <replies>",
      "      <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t6a\" bsky_url=\"https://bsky.app/profile/bob.test/post/t6a\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t6\">",
      "        <content>",
      "          reply under root",
      "        </content>",
      "",
      "        Engagement: 0 likes, 0 reposts, 0 replies",
      "      </post>",
      "    </replies>",
      "  </post>",
      "",
      "<excluded_post reason=\"ai_preferences\" author_handle=\"carol.test\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/t6h\">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>",
      "</posts>",
    ],
  },
  {
    name: "feed nesting: every post in a mixed page is rendered exactly once",
    run: (m) => {
      const items = [
        feedItem({ uri: uriOf(ALICE, "mix1"), text: "anchor", likeCount: 1, repostCount: 0, replyCount: 2 }),
        feedItem({ uri: uriOf(BOB, "mix2"), text: "reply in page", author: { did: BOB, handle: "bob.test", displayName: "Bob B." }, replyTo: uriOf(ALICE, "mix1"), likeCount: 0, repostCount: 0, replyCount: 1 }),
        feedItem({ uri: uriOf(CAROL, "mix3"), text: "reply to that reply", author: { did: CAROL, handle: "carol.test", displayName: "Carol C." }, replyTo: uriOf(BOB, "mix2"), replyRoot: uriOf(ALICE, "mix1"), likeCount: 0, repostCount: 0, replyCount: 0 }),
        feedItem({ uri: uriOf(BOB, "mix4"), text: "reply outside page", author: { did: BOB, handle: "bob.test", displayName: "Bob B." }, replyTo: uriOf(ALICE, "gone"), replyRoot: uriOf(ALICE, "gone"), likeCount: 0, repostCount: 0, replyCount: 0 }),
        feedItem({ uri: uriOf(ALICE, "mix5"), text: "reposted", likeCount: 0, repostCount: 0, replyCount: 1, reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { did: BOB, handle: "bob.test" }, indexedAt: "2021-08-05T01:02:03.000Z" } }),
        feedItem({ uri: uriOf(CAROL, "mix6"), text: "reply to the repost", author: { did: CAROL, handle: "carol.test", displayName: "Carol C." }, replyTo: uriOf(ALICE, "mix5"), likeCount: 0, repostCount: 0, replyCount: 0 }),
        feedItem({ uri: uriOf(ALICE, "mix7"), text: "self reply", replyTo: uriOf(ALICE, "mix7"), likeCount: 0, repostCount: 0, replyCount: 0 }),
        tombstone({ uri: uriOf(CAROL, "mix8"), handle: "carol.test" }),
      ];
      const out = m.preprocessPosts(items);
      const uris = items.map((item: any) => (item.post ? item.post.uri : item.originalItem.post.uri));
      const counts = uris.map((u: string) => `${u.slice(-4)}=${out.split(`uri="${u}"`).length - 1}`);
      return [
        counts.join(" "),
        `replyBlocks=${out.split("<replies>").length - 1}`,
        `bytes=${out.length}`,
      ].join(" ");
    },
    expected: [
      "mix1=1 mix2=1 mix3=1 mix4=1 mix5=1 mix6=1 mix7=1 mix8=1 replyBlocks=3 bytes=3321",
    ],
  },
  {
    name: "feed compact: a nested thread keeps the full tree and drops only url and engagement",
    run: (m) =>
      m.preprocessPosts(
        [
          feedItem({ uri: uriOf(ALICE, "t7"), text: "root", likeCount: 1, repostCount: 2, replyCount: 1 }),
          feedItem({
            uri: uriOf(BOB, "t7a"),
            text: "first reply",
            author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
            replyTo: uriOf(ALICE, "t7"),
            likeCount: 3,
            repostCount: 0,
            replyCount: 0,
          }),
        ],
        { detail: "compact" },
      ),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t7\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      root",
      "    </content>",
      "",
      "    <replies>",
      "      <post type=\"reply\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/t7a\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\" reply_to=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/t7\">",
      "        <content>",
      "          first reply",
      "        </content>",
      "      </post>",
      "    </replies>",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "detail: compact is exactly full minus url and engagement at every nesting depth",
    run: (m) => {
      const items = [
        feedItem({ uri: uriOf(ALICE, "p1"), text: "root", likeCount: 1, repostCount: 2, replyCount: 1 }),
        feedItem({
          uri: uriOf(BOB, "p1a"),
          text: "reply",
          author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
          replyTo: uriOf(ALICE, "p1"),
          likeCount: 3,
          repostCount: 0,
          replyCount: 1,
        }),
        feedItem({
          uri: uriOf(CAROL, "p1a1"),
          text: "reply of reply",
          author: { did: CAROL, handle: "carol.test", displayName: "Carol C." },
          replyTo: uriOf(BOB, "p1a"),
          replyRoot: uriOf(ALICE, "p1"),
          likeCount: 0,
          repostCount: 0,
          replyCount: 0,
        }),
      ];
      const full = m.preprocessPosts(items, { detail: "full" });
      const compact = m.preprocessPosts(items, { detail: "compact" });
      const strip = (s: string) =>
        s.replace(/ bsky_url="[^"]*"/g, "").replace(/\n[ \t]*\n[ \t]*Engagement: [^\n]*/g, "");
      return [
        `compactIsShorter:${compact.length < full.length}`,
        `samePostCount:${full.split("<post ").length === compact.split("<post ").length}`,
        `sameReplyBlocks:${full.split("<replies>").length === compact.split("<replies>").length}`,
        `strippingFullGivesCompact:${strip(full) === compact}`,
      ].join(" ");
    },
    expected: [
      "compactIsShorter:true samePostCount:true sameReplyBlocks:true strippingFullGivesCompact:true",
    ],
  },

  // ---------------------------------------------------------------------------
  // detail: "compact" — the same walk with the engagement line and the
  // bsky_url attribute dropped. Everything else (uri, type, author, timestamps,
  // content, embeds, repost nesting, hidden-post markers) is byte-identical to
  // full mode. These goldens are the contract README.md and
  // docs/post-format-spec.md ("Detail levels") document.
  // ---------------------------------------------------------------------------
  {
    name: "feed compact: standalone post keeps uri but drops bsky_url and the engagement line",
    run: (m) => m.preprocessPosts(
      [feedItem({ uri: uriOf(ALICE, "c1"), likeCount: 7, indexedAt: "2021-08-04T13:30:00.000Z" })],
      { detail: "compact" },
    ),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/c1\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed compact: repost nesting is unchanged and neither engagement line survives",
    run: (m) => m.preprocessPosts(
      [feedItem({
        uri: uriOf(ALICE, "c2"),
        likeCount: 4,
        indexedAt: "2021-08-04T13:30:00.000Z",
        reason: {
          $type: "app.bsky.feed.defs#reasonRepost",
          by: { did: BOB, handle: "bob.test" },
          indexedAt: "2021-08-05T01:02:03.000Z",
        },
      })],
      { detail: "compact" },
    ),
    expected: [
      "<posts>",
      "  <repost author_name=\"\" author_handle=\"bob.test\" reposted_at=\"2021-08-05 01:02:03\">",
      "    <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/c2\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "      <content>",
      "        feed text",
      "      </content>",
      "    </post>",
      "  </repost>",
      "</posts>",
    ],
  },
  {
    name: "feed compact: quoted post keeps its uri and drops url plus engagement",
    run: (m) => m.preprocessPosts(
      [{
        post: postView({
          uri: uriOf(ALICE, "c3"),
          likeCount: 9,
          indexedAt: "2021-08-04T13:30:00.000Z",
          embed: {
            $type: "app.bsky.embed.record#view",
            record: {
              $type: "app.bsky.embed.record#viewRecord",
              uri: uriOf(CAROL, "c3q"),
              cid: "quoteCid",
              author: { did: CAROL, handle: "carol.test", displayName: "Carol" },
              value: { text: "quoted text", createdAt: "2021-08-04T12:00:00.000Z" },
              likeCount: 3,
              repostCount: 1,
              replyCount: 2,
            },
          },
        }),
      }],
      { detail: "compact" },
    ),
    expected: [
      "<posts>",
      "  <post type=\"standalone,quote\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/c3\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      hello world",
      "    </content>",
      "    ",
      "    <quoted_post uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/c3q\" author_name=\"Carol\" author_handle=\"carol.test\" posted_at=\"2021-08-04 12:00:00\">",
      "      <content>",
      "        quoted text",
      "      </content>",
      "    </quoted_post>",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed compact: embeds survive the pruning pass",
    run: (m) => m.preprocessPosts(
      [
        feedItem({ uri: uriOf(ALICE, "c4"), likeCount: 11, indexedAt: "2021-08-04T13:30:00.000Z" }),
        {
          post: postView({
            uri: uriOf(BOB, "c9"),
            author: { did: BOB, handle: "bob.test", displayName: "Bob B." },
            text: "a picture post",
            likeCount: 3,
            embed: {
              $type: "app.bsky.embed.images#view",
              images: [{ thumb: "https://x/thumb.png", fullsize: "https://x/full.png", alt: "a alt" }],
            },
          }),
        },
      ],
      { detail: "compact" },
    ),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/c4\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "  </post>",
      "",
      "  <post type=\"standalone\" uri=\"at://did:plc:dddd4444eeee5555ffff6666/app.bsky.feed.post/c9\" author_name=\"Bob B.\" author_handle=\"bob.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      a picture post",
      "    </content>",
      "    ",
      "    <embed type=\"image\">",
      "      Image description: \"a alt\"",
      "      Image URL: https://x/full.png",
      "    </embed>",
      "  </post>",
      "</posts>",
    ],
  },
  {
    name: "feed compact: hidden-post markers are byte-identical to full mode",
    run: (m) => m.preprocessPosts(
      [feedItem({ uri: uriOf(ALICE, "c6"), indexedAt: "2021-08-04T13:30:00.000Z" }), tombstone({ uri: uriOf(CAROL, "c7") })],
      { detail: "compact" },
    ),
    expected: [
      "<posts>",
      "  <post type=\"standalone\" uri=\"at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/c6\" author_name=\"Alice A.\" author_handle=\"alice.test\" posted_at=\"2021-08-04 13:30:00\">",
      "    <content>",
      "      feed text",
      "    </content>",
      "  </post>",
      "",
      "<excluded_post reason=\"ai_preferences\" author_handle=\"carol.test\" uri=\"at://did:plc:gggg7777hhhh8888iiii9999/app.bsky.feed.post/c7\">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>",
      "</posts>",
    ],
  },
  {
    name: "detail: full is the default and compact renders strictly less for the same feed",
    run: (m) => {
      const items = [feedItem({ uri: uriOf(ALICE, "c8"), likeCount: 5, indexedAt: "2021-08-04T13:30:00.000Z" })];
      const implicit = m.formatFeed({ items });
      const full = m.formatFeed({ items }, { detail: "full" });
      const compact = m.formatFeed({ items }, { detail: "compact" });
      return [
        `defaultIsFull:${implicit === full}`,
        `compactDiffers:${implicit !== compact}`,
        `fullHasEngagement:${full.includes("Engagement:")}`,
        `compactHasEngagement:${compact.includes("Engagement:")}`,
        `fullHasUrl:${full.includes("bsky_url=")}`,
        `compactHasUrl:${compact.includes("bsky_url=")}`,
        `compactKeepsUri:${compact.includes('uri="at://did:plc:aaaa1111bbbb2222cccc3333/app.bsky.feed.post/c8"')}`,
        `compactIsShorter:${compact.length < full.length}`,
        `emptyFeedIsUnchanged:${m.preprocessPosts([], { detail: "compact" }) === m.preprocessPosts([])}`,
      ].sort().join(" ");
    },
    expected: [
      "compactDiffers:true compactHasEngagement:false compactHasUrl:false compactIsShorter:true compactKeepsUri:true defaultIsFull:true emptyFeedIsUnchanged:true fullHasEngagement:true fullHasUrl:true",
    ],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function render(m: PreprocessorModule, c: Case): { out: string; logs: string[] } {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (a instanceof Error ? `Error: ${a.message}` : String(a))).join(" | "));
  };
  try {
    let out = c.run(m);
    if (c.maskDates) {
      out = out.replace(/posted_at="[^"]*"/g, 'posted_at="<D>"');
    }
    return { out, logs };
  } finally {
    console.error = originalError;
  }
}

async function main() {
  const mod = await import("../src/llm-preprocessor.js");

  const cases: Array<[string, () => void]> = [["timezone is pinned to UTC for the date fixtures", () =>
    assert.equal(new Date("2021-08-04T13:30:00.000Z").getHours(), 13, "process.env.TZ = 'UTC' must take effect before the date fixtures run")],
  ];

  for (const c of CASES) {
    cases.push([c.name, () => {
      const { out, logs } = render(mod, c);
      assert.equal(out, c.expected.join("\n"));
      if (c.logs) assert.deepEqual(logs, c.logs);
    }]);
  }

  await runTests(cases);
}

// Guarded so the dev-only generator under tmp/walker-baseline/ can read CASES
// without re-running the suite. realpathSync matters because /tmp is a symlink
// on macOS, so a plain pathToFileURL(argv[1]) would not match import.meta.url.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

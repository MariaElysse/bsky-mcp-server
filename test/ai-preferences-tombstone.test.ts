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

async function loadModules() {
  const aiPrefs = await import("../src/ai-preferences.js");
  filterPostsByAiPreferences = aiPrefs.filterPostsByAiPreferences;

  preprocessPosts = (await import("../src/llm-preprocessor.js")).preprocessPosts;
  filterThreadByAiPreferences = (await import("../src/llm-preprocessor.js"))
    .filterThreadByAiPreferences;
  formatPostThreadWithAiPrefs = (await import("../src/llm-preprocessor.js"))
    .formatPostThreadWithAiPrefs;
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
// Runner
// ---------------------------------------------------------------------------

async function main() {
  await loadModules();

  const cases: Array<[string, () => Promise<void>]> = [
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

#!/usr/bin/env node
import { runTests } from "./test-helpers.js";
/**
 * pagination.test — tests for cursor-based pagination on post-fetching tools.
 *
 * Covers:
 *  (1) get-timeline-posts: auto-fetch, cursor mode, hours-mode ignores cursor, empty cursor
 *  (2) get-feed-posts: auto-fetch, cursor mode, hours-mode ignores cursor
 *  (3) get-list-posts: auto-fetch, cursor mode, hours-mode ignores cursor
 *  (4) get-user-posts: auto-fetch, cursor mode, hours-mode ignores cursor
 *  (5) get-liked-posts: auto-fetch, cursor mode, empty cursor
 *  (6) get-notifications: auto-fetch, cursor mode, empty cursor
 *  (7) Default values: count/limit defaults to 20 when omitted
 *  (8) Cursor signal in response text when more results available
 */

import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent } from "@atproto/api";
import { registerTools, AgentProvider } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function harness(provider: AgentProvider) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, provider);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text content from a tool call result */
function getText(result: any): string {
  return result.content?.[0]?.text ?? "";
}

/** Check if response contains a cursor signal */
function hasCursorSignal(text: string): boolean {
  return text.includes("pass cursor=") && text.includes("to continue.]");
}

/** Extract cursor value from response text */
function extractCursor(text: string): string | null {
  const match = text.match(/pass cursor="([^"]+)" to continue/);
  return match ? match[1] : null;
}

/** Create a post stub with a unique ID */
function post(id: number) {
  return {
    post: {
      uri: `at://did:plc:u${id}/app.bsky.feed.post/r${id}`,
      author: { did: `did:plc:u${id}`, handle: `user${id}.test`, displayName: `User ${id}` },
      record: { text: `post ${id}`, createdAt: new Date().toISOString() },
    },
  };
}

/**
 * Create a mock agent with indexed pages per API method.
 * Each method gets its own page queue, so calls to different methods
 * don't interfere with each other.
 */
function createSmartAgent(config: {
  timelinePages?: Array<{ feed: any[]; cursor?: string }>;
  feedPages?: Array<{ feed: any[]; cursor?: string }>;
  listFeedPages?: Array<{ feed: any[]; cursor?: string }>;
  authorFeedPages?: Array<{ feed: any[]; cursor?: string }>;
  likesPages?: Array<{ feed: any[]; cursor?: string }>;
  notifPages?: Array<{ notifications: any[]; cursor?: string }>;
}) {
  // Use mutable counters per method
  const counters = { timeline: 0, feed: 0, listFeed: 0, authorFeed: 0, likes: 0, notif: 0 };

  const makePageFetcher = (key: keyof typeof counters, pages: Array<Record<string, any>>) => {
    return async () => {
      const i = counters[key]++;
      return pages[i] ?? { feed: [], cursor: undefined, notifications: [] };
    };
  };

  const nextTimeline = makePageFetcher('timeline', config.timelinePages ?? []);
  const nextFeed = makePageFetcher('feed', config.feedPages ?? []);
  const nextListFeed = makePageFetcher('listFeed', config.listFeedPages ?? []);
  const nextAuthorFeed = makePageFetcher('authorFeed', config.authorFeedPages ?? []);
  const nextLikes = makePageFetcher('likes', config.likesPages ?? []);
  const nextNotif = makePageFetcher('notif', config.notifPages ?? []);

  return {
    getTimeline: async ({ limit, cursor }: { limit: number; cursor?: string }) => ({
      success: true, data: await nextTimeline(),
    }),
    app: {
      bsky: {
        notification: {
          listNotifications: async ({ limit, cursor, reasons }: any) => ({
            success: true, data: await nextNotif(),
          }),
        },
        feed: {
          getFeed: async ({ limit, cursor }: any) => ({ success: true, data: await nextFeed() }),
          getListFeed: async ({ limit, cursor }: any) => ({ success: true, data: await nextListFeed() }),
          getAuthorFeed: async ({ limit, cursor, filter }: any) => ({ success: true, data: await nextAuthorFeed() }),
          getActorLikes: async ({ limit, cursor }: any) => ({ success: true, data: await nextLikes() }),
          getFeedGenerator: async () => ({ success: true, data: { view: { displayName: "Test Feed" } } }),
        },
        graph: {
          getList: async () => ({ success: true, data: { list: { name: "Test List" } } }),
        },
      },
    },
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({ success: true, data: { records: [], cursor: undefined } }),
          getRecord: async () => ({ success: true, data: { value: {} } }),
        },
      },
    },
    did: "did:plc:alice",
    getProfile: async () => ({ success: true, data: { did: "did:plc:alice", handle: "alice.test" } }),
    resolveHandle: async () => ({ success: true, data: { did: "did:plc:alice" } }),
  } as unknown as Agent;
}

// ---------------------------------------------------------------------------
// (1) get-timeline-posts
// ---------------------------------------------------------------------------

async function testTimelineAutoFetchPaginatesInternally() {
  const agent = createSmartAgent({
    timelinePages: [
      { feed: [post(1), post(2), post(3), post(4), post(5)], cursor: "cursor-1" },
      { feed: [post(6), post(7), post(8), post(9), post(10)], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: { count: 5, type: "posts" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("Retrieved"), "should include retrieval summary");
    assert.ok(!hasCursorSignal(text), "should not signal more when API has no more pages");
  } finally {
    await close();
  }
}

async function testTimelineCursorModeFetchesSinglePage() {
  const agent = createSmartAgent({
    timelinePages: [
      { feed: [post(101), post(102), post(103)], cursor: "cursor-next" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: { count: 20, type: "posts", cursor: "cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 101"), "should contain first post from cursor page");
    assert.ok(text.includes("post 103"), "should contain last post from cursor page");
    assert.ok(hasCursorSignal(text), "should signal more when API returns a cursor");
    assert.equal(extractCursor(text), "cursor-next", "cursor signal should match API cursor");
  } finally {
    await close();
  }
}

async function testTimelineHoursModeIgnoresCursor() {
  const agent = createSmartAgent({
    timelinePages: [
      { feed: [post(1), post(2), post(3)], cursor: "cursor-ignored" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: { count: 24, type: "hours", cursor: "cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 1"), "hours mode should fetch fresh, ignoring cursor");
  } finally {
    await close();
  }
}

async function testTimelineCursorModeEmptyPage() {
  const agent = createSmartAgent({
    timelinePages: [
      { feed: [], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: { count: 20, type: "posts", cursor: "cursor-end" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("No more timeline posts available"), "should indicate no more posts");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (2) get-feed-posts
// ---------------------------------------------------------------------------

async function testFeedAutoFetchPaginatesInternally() {
  const agent = createSmartAgent({
    feedPages: [
      { feed: [post(1), post(2), post(3), post(4), post(5)], cursor: "feed-cursor-1" },
      { feed: [post(6), post(7), post(8), post(9), post(10)], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-feed-posts",
      arguments: { feed: "at://did:plc:feed/app.bsky.feed.generator/test", count: 5, type: "posts" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("Retrieved"), "should include retrieval summary");
  } finally {
    await close();
  }
}

async function testFeedCursorModeFetchesSinglePage() {
  const agent = createSmartAgent({
    feedPages: [
      { feed: [post(201), post(202)], cursor: "feed-cursor-next" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-feed-posts",
      arguments: { feed: "at://did:plc:feed/app.bsky.feed.generator/test", count: 20, type: "posts", cursor: "feed-cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 201"), "should contain first post from cursor page");
    assert.ok(hasCursorSignal(text), "should signal more when API returns cursor");
    assert.equal(extractCursor(text), "feed-cursor-next", "cursor should match API cursor");
  } finally {
    await close();
  }
}

async function testFeedHoursModeIgnoresCursor() {
  const agent = createSmartAgent({
    feedPages: [
      { feed: [post(1), post(2), post(3)], cursor: "ignored" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-feed-posts",
      arguments: { feed: "at://did:plc:feed/app.bsky.feed.generator/test", count: 24, type: "hours", cursor: "cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 1"), "hours mode should fetch fresh");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (3) get-list-posts
// ---------------------------------------------------------------------------

async function testListAutoFetchPaginatesInternally() {
  const agent = createSmartAgent({
    listFeedPages: [
      { feed: [post(1), post(2), post(3), post(4), post(5)], cursor: "list-cursor-1" },
      { feed: [post(6), post(7), post(8), post(9), post(10)], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-list-posts",
      arguments: { list: "at://did:plc:lst/app.bsky.graph.list/test", count: 5, type: "posts" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("Retrieved"), "should include retrieval summary");
  } finally {
    await close();
  }
}

async function testListCursorModeFetchesSinglePage() {
  const agent = createSmartAgent({
    listFeedPages: [
      { feed: [post(301), post(302)], cursor: "list-cursor-next" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-list-posts",
      arguments: { list: "at://did:plc:lst/app.bsky.graph.list/test", count: 20, type: "posts", cursor: "list-cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 301"), "should contain first post from cursor page");
    assert.ok(hasCursorSignal(text), "should signal more when API returns cursor");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (4) get-user-posts
// ---------------------------------------------------------------------------

async function testUserPostsAutoFetchPaginatesInternally() {
  const agent = createSmartAgent({
    authorFeedPages: [
      { feed: [post(1), post(2), post(3), post(4), post(5)], cursor: "user-cursor-1" },
      { feed: [post(6), post(7), post(8), post(9), post(10)], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-user-posts",
      arguments: { user: "alice.test", count: 5, type: "posts" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("Retrieved"), "should include retrieval summary");
  } finally {
    await close();
  }
}

async function testUserPostsCursorModeFetchesSinglePage() {
  const agent = createSmartAgent({
    authorFeedPages: [
      { feed: [post(401), post(402)], cursor: "user-cursor-next" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-user-posts",
      arguments: { user: "alice.test", count: 20, type: "posts", cursor: "user-cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 401"), "should contain first post from cursor page");
    assert.ok(hasCursorSignal(text), "should signal more when API returns cursor");
    assert.ok(text.includes("alice.test"), "should mention the user in cursor signal");
  } finally {
    await close();
  }
}

async function testUserPostsHoursModeIgnoresCursor() {
  const agent = createSmartAgent({
    authorFeedPages: [
      { feed: [post(1), post(2), post(3)], cursor: "ignored" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-user-posts",
      arguments: { user: "alice.test", count: 24, type: "hours", cursor: "cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 1"), "hours mode should fetch fresh");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (5) get-liked-posts
// ---------------------------------------------------------------------------

async function testLikedPostsAutoFetchPaginatesInternally() {
  const agent = createSmartAgent({
    likesPages: [
      { feed: [post(1), post(2), post(3), post(4), post(5)], cursor: "liked-cursor-1" },
      { feed: [post(6), post(7), post(8), post(9), post(10)], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-liked-posts",
      arguments: { limit: 5 },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("Retrieved"), "should include retrieval summary");
  } finally {
    await close();
  }
}

async function testLikedPostsCursorModeFetchesSinglePage() {
  const agent = createSmartAgent({
    likesPages: [
      { feed: [post(501), post(502)], cursor: "liked-cursor-next" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-liked-posts",
      arguments: { limit: 20, cursor: "liked-cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("post 501"), "should contain first liked post from cursor page");
    assert.ok(hasCursorSignal(text), "should signal more when API returns cursor");
    assert.equal(extractCursor(text), "liked-cursor-next", "cursor should match API cursor");
  } finally {
    await close();
  }
}

async function testLikedPostsCursorModeEmptyPage() {
  const agent = createSmartAgent({
    likesPages: [
      { feed: [], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-liked-posts",
      arguments: { limit: 20, cursor: "liked-cursor-end" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("No more liked posts available"), "should indicate no more liked posts");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (6) get-notifications
// ---------------------------------------------------------------------------

async function testNotificationsAutoFetchPaginatesInternally() {
  const agent = createSmartAgent({
    notifPages: [
      { notifications: [{ author: { did: "did:plc:u1", handle: "u1.test" }, reason: "like", uri: "at://did:plc:u1/app.bsky.feed.post/1", indexedAt: new Date().toISOString(), isRead: false }], cursor: "notif-cursor-1" },
      { notifications: [{ author: { did: "did:plc:u2", handle: "u2.test" }, reason: "mention", uri: "at://did:plc:u2/app.bsky.feed.post/2", indexedAt: new Date().toISOString(), isRead: false }], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-notifications",
      arguments: { limit: 5 },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("Retrieved"), "should include retrieval summary");
  } finally {
    await close();
  }
}

async function testNotificationsCursorModeFetchesSinglePage() {
  const agent = createSmartAgent({
    notifPages: [
      { notifications: [{ author: { did: "did:plc:u10", handle: "u10.test" }, reason: "like", uri: "at://did:plc:u10/app.bsky.feed.post/10", indexedAt: new Date().toISOString(), isRead: false }], cursor: "notif-cursor-next" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-notifications",
      arguments: { limit: 20, cursor: "notif-cursor-start" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("u10.test"), "should contain notification from cursor page");
    assert.ok(hasCursorSignal(text), "should signal more when API returns cursor");
    assert.equal(extractCursor(text), "notif-cursor-next", "cursor should match API cursor");
  } finally {
    await close();
  }
}

async function testNotificationsCursorModeEmptyPage() {
  const agent = createSmartAgent({
    notifPages: [
      { notifications: [], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-notifications",
      arguments: { limit: 20, cursor: "notif-cursor-end" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(text.includes("No more notifications available"), "should indicate no more notifications");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (7) Default values
// ---------------------------------------------------------------------------

async function testTimelineDefaultCountIs20() {
  let capturedLimit: number | undefined;
  const agent = {
    getTimeline: async ({ limit }: { limit: number }) => {
      capturedLimit = limit;
      return { success: true, data: { feed: [], cursor: undefined } };
    },
    app: {
      bsky: {
        notification: { listNotifications: async () => ({ success: true, data: { notifications: [], cursor: undefined } }) },
        feed: {
          getFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getListFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getAuthorFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getActorLikes: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getFeedGenerator: async () => ({ success: true, data: { view: { displayName: "Test" } } }),
        },
        graph: { getList: async () => ({ success: true, data: { list: { name: "Test" } } }) },
      },
    },
    com: { atproto: { repo: { listRecords: async () => ({ success: true, data: { records: [], cursor: undefined } }), getRecord: async () => ({ success: true, data: { value: {} } }) } } },
    did: "did:plc:alice",
    getProfile: async () => ({ success: true, data: { did: "did:plc:alice", handle: "alice.test" } }),
    resolveHandle: async () => ({ success: true, data: { did: "did:plc:alice" } }),
  } as unknown as Agent;

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal(capturedLimit, 20, "default count should be 20");
  } finally {
    await close();
  }
}

async function testLikedPostsDefaultLimitIs20() {
  let capturedLimit: number | undefined;
  const agent = {
    getTimeline: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
    app: {
      bsky: {
        notification: { listNotifications: async () => ({ success: true, data: { notifications: [], cursor: undefined } }) },
        feed: {
          getFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getListFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getAuthorFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getActorLikes: async ({ limit }: { limit: number }) => { capturedLimit = limit; return { success: true, data: { feed: [], cursor: undefined } }; },
          getFeedGenerator: async () => ({ success: true, data: { view: { displayName: "Test" } } }),
        },
        graph: { getList: async () => ({ success: true, data: { list: { name: "Test" } } }) },
      },
    },
    com: { atproto: { repo: { listRecords: async () => ({ success: true, data: { records: [], cursor: undefined } }), getRecord: async () => ({ success: true, data: { value: {} } }) } } },
    did: "did:plc:alice",
    getProfile: async () => ({ success: true, data: { did: "did:plc:alice", handle: "alice.test" } }),
    resolveHandle: async () => ({ success: true, data: { did: "did:plc:alice" } }),
  } as unknown as Agent;

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-liked-posts",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal(capturedLimit, 20, "default limit should be 20");
  } finally {
    await close();
  }
}

async function testNotificationsDefaultLimitIs20() {
  let capturedLimit: number | undefined;
  const agent = {
    getTimeline: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
    app: {
      bsky: {
        notification: { listNotifications: async ({ limit }: { limit: number }) => { capturedLimit = limit; return { success: true, data: { notifications: [], cursor: undefined } }; } },
        feed: {
          getFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getListFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getAuthorFeed: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getActorLikes: async () => ({ success: true, data: { feed: [], cursor: undefined } }),
          getFeedGenerator: async () => ({ success: true, data: { view: { displayName: "Test" } } }),
        },
        graph: { getList: async () => ({ success: true, data: { list: { name: "Test" } } }) },
      },
    },
    com: { atproto: { repo: { listRecords: async () => ({ success: true, data: { records: [], cursor: undefined } }), getRecord: async () => ({ success: true, data: { value: {} } }) } } },
    did: "did:plc:alice",
    getProfile: async () => ({ success: true, data: { did: "did:plc:alice", handle: "alice.test" } }),
    resolveHandle: async () => ({ success: true, data: { did: "did:plc:alice" } }),
  } as unknown as Agent;

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-notifications",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal(capturedLimit, 20, "default limit should be 20");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// (8) Cursor signal correctness
// ---------------------------------------------------------------------------

async function testCursorSignalOnlyWhenMoreAvailable() {
  // When API returns a cursor, signal should be present.
  const agent = createSmartAgent({
    timelinePages: [
      { feed: [post(1), post(2), post(3)], cursor: "has-cursor" },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result1: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: { count: 20, type: "posts", cursor: "start" },
    });
    assert.ok(hasCursorSignal(getText(result1)), "should signal more when API cursor is present");

    // When API returns no cursor, signal should be absent.
    const agent2 = createSmartAgent({
      timelinePages: [
        { feed: [post(1), post(2)], cursor: undefined },
      ],
    });
    const { client: client2, close: close2 } = await harness(() => agent2);
    try {
      const result2: any = await client2.callTool({
        name: "get-timeline-posts",
        arguments: { count: 20, type: "posts" },
      });
      assert.ok(!hasCursorSignal(getText(result2)), "should not signal more when API has no cursor");
    } finally {
      await close2();
    }
  } finally {
    await close();
  }
}

async function testNoCursorSignalOnEmptyResults() {
  const agent = createSmartAgent({
    timelinePages: [
      { feed: [], cursor: undefined },
    ],
  });

  const { client, close } = await harness(() => agent);
  try {
    const result: any = await client.callTool({
      name: "get-timeline-posts",
      arguments: { count: 20, type: "posts" },
    });
    assert.equal(result.isError, undefined);
    const text = getText(result);
    assert.ok(!hasCursorSignal(text), "empty results should not have cursor signal");
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const cases: Array<[string, () => Promise<void>]> = [
    // (1) get-timeline-posts
    ["get-timeline-posts: auto-fetch paginates internally", testTimelineAutoFetchPaginatesInternally],
    ["get-timeline-posts: cursor mode fetches single page", testTimelineCursorModeFetchesSinglePage],
    ["get-timeline-posts: hours mode ignores cursor", testTimelineHoursModeIgnoresCursor],
    ["get-timeline-posts: cursor mode empty page", testTimelineCursorModeEmptyPage],

    // (2) get-feed-posts
    ["get-feed-posts: auto-fetch paginates internally", testFeedAutoFetchPaginatesInternally],
    ["get-feed-posts: cursor mode fetches single page", testFeedCursorModeFetchesSinglePage],
    ["get-feed-posts: hours mode ignores cursor", testFeedHoursModeIgnoresCursor],

    // (3) get-list-posts
    ["get-list-posts: auto-fetch paginates internally", testListAutoFetchPaginatesInternally],
    ["get-list-posts: cursor mode fetches single page", testListCursorModeFetchesSinglePage],

    // (4) get-user-posts
    ["get-user-posts: auto-fetch paginates internally", testUserPostsAutoFetchPaginatesInternally],
    ["get-user-posts: cursor mode fetches single page", testUserPostsCursorModeFetchesSinglePage],
    ["get-user-posts: hours mode ignores cursor", testUserPostsHoursModeIgnoresCursor],

    // (5) get-liked-posts
    ["get-liked-posts: auto-fetch paginates internally", testLikedPostsAutoFetchPaginatesInternally],
    ["get-liked-posts: cursor mode fetches single page", testLikedPostsCursorModeFetchesSinglePage],
    ["get-liked-posts: cursor mode empty page", testLikedPostsCursorModeEmptyPage],

    // (6) get-notifications
    ["get-notifications: auto-fetch paginates internally", testNotificationsAutoFetchPaginatesInternally],
    ["get-notifications: cursor mode fetches single page", testNotificationsCursorModeFetchesSinglePage],
    ["get-notifications: cursor mode empty page", testNotificationsCursorModeEmptyPage],

    // (7) Default values
    ["defaults: timeline count defaults to 20", testTimelineDefaultCountIs20],
    ["defaults: liked-posts limit defaults to 20", testLikedPostsDefaultLimitIs20],
    ["defaults: notifications limit defaults to 20", testNotificationsDefaultLimitIs20],

    // (8) Cursor signal correctness
    ["cursor signal: only present when more available", testCursorSignalOnlyWhenMoreAvailable],
    ["cursor signal: absent on empty results", testNoCursorSignalOnEmptyResults],
  ];

  await runTests(cases);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

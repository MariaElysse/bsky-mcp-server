// Implements the spec described in docs/post-format-spec.md
import type {
  AppBskyFeedDefs,
  AppBskyEmbedImages,
  AppBskyEmbedVideo,
  AppBskyEmbedExternal,
  AppBskyEmbedRecord,
  AppBskyFeedPost
} from '@atproto/api';
import { RichText } from '@atproto/api';
import { escapeXml } from './utils.js';

/**
 * Base URL for the Bluesky web frontend.  Defaults to bsky.app (the
 * universal web client) but can be overridden for custom frontends.
 * Used to generate bsky_url attributes in formatted output.
 */
const BSKY_WEB_URL = (process.env.BSKY_WEB_URL ?? 'https://bsky.app').replace(/\/$/, '');

/**
 * Convert Bluesky post text + facets into Markdown
 * @param text The post text content
 * @param facets Optional array of facets from the post
 * @returns Markdown formatted text with proper links and mentions
 */
export function facetsToMarkdown(text: string, facets?: any[]): string {
  if (!text) return '';
  
  // Initialize RichText with the text and facets
  const rt = new RichText({ text, facets: facets ?? [] });
  
  // Transform segments into Markdown
  let markdown = '';
  for (const segment of rt.segments()) {
    if (segment.isLink()) {
      //markdown += `[${segment.text}](${segment.link?.uri})`;
      markdown += `<${segment.link?.uri}>`; // use the markdown auto-link syntax for simplicity for the LLM instead of linking the text fragment
    } else if (segment.isMention()) {
      markdown += `[${segment.text}](${BSKY_WEB_URL}/profile/${segment.mention?.did})`;
    } else if (segment.isTag()) {
      markdown += `#${segment.tag?.tag}`;
    } else {
      markdown += segment.text;
    }
  }
  
  return markdown;
}

/**
 * `addLeadingZeros` equivalent from date-fns' formatter, kept local so the
 * output stays byte-for-byte what `formatISO9075` used to produce (including the
 * sign handling and the 4-digit zero-padded year).
 */
function padNumber(value: number, length: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + Math.abs(value).toString().padStart(length, '0');
}

/**
 * Formats a date to a human-readable format
 *
 * This is the ISO 9075 rendering date-fns used to hand us: local-time
 * `YYYY-MM-DD HH:mm:ss` with a *space* separator — there is no `T` in that
 * output, which is why the old `.replace('T', ', ')` never changed anything.
 * An unparseable input still throws `RangeError('Invalid time value')` so the
 * catch below keeps returning the original string.
 *
 * date-fns is no longer a dependency of this project — nothing imports it —
 * but the shape of its output is what the tests pin, so the helpers above keep
 * reproducing it rather than switching to `toISOString()`.
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      throw new RangeError('Invalid time value');
    }

    return (
      `${padNumber(date.getFullYear(), 4)}-${padNumber(date.getMonth() + 1, 2)}-${padNumber(date.getDate(), 2)}` +
      ` ${padNumber(date.getHours(), 2)}:${padNumber(date.getMinutes(), 2)}:${padNumber(date.getSeconds(), 2)}`
    );
  } catch (e) {
    return dateString;
  }
}

/**
 * Creates a Bluesky web URL from a post URI.
 * Uses BSKY_WEB_URL env var (default: https://bsky.app) so it works
 * with custom web frontends on alternate endpoints.
 */
function createBskyUrl(uri: string, handle?: string): string {
  try {
    const parts = uri.split('/');
    const did = parts[2];
    const rkey = parts[parts.length - 1];
    return `${BSKY_WEB_URL}/profile/${handle || did}/post/${rkey}`;
  } catch (e) {
    return '';
  }
}

/**
 * Build a space-separated XML attribute string from ordered [key, value] pairs.
 * Every value is escaped with escapeXml, so user-controlled strings (display
 * names, handles, URIs) can never close an attribute early or inject extra
 * attributes — escaping is by construction, not by memory.
 * @param entries Ordered [key, value] pairs; attribute order is preserved.
 * @returns Attributes rendered as `key="escaped-value"`, joined by spaces.
 */
function xmlAttrs(entries: Array<readonly [string, string]>): string {
  return entries.map(([key, value]) => `${key}="${escapeXml(value)}"`).join(' ');
}

/**
 * Determines the post type based on its properties. The repost reason is not a
 * parameter: reposts are rendered by a dedicated `<repost>` element, and the
 * remaining types come from the record itself.
 */
function determinePostType(post: AppBskyFeedDefs.PostView): string[] {
  const types: string[] = [];
  
  // Base type
  const record = post.record as AppBskyFeedPost.Record;
  if (record.reply) {
    types.push('reply');
  } else {
    types.push('standalone');
  }
  
  // Note: repost is no longer a post type since we're using a dedicated repost structure
  
  // Check if it has a quoted post
  if (post.embed && post.embed.$type === 'app.bsky.embed.record#view') {
    types.push('quote');
  }
  
  // We're no longer tracking reply limitations
  
  return types;
}

/**
 * Format a single post according to the spec
 */
function formatPost(feedItem: AppBskyFeedDefs.FeedViewPost): string {
  const { post, reply, reason } = feedItem;
  
  // Handle repost specially
  if (reason && reason.$type === 'app.bsky.feed.defs#reasonRepost') {
    // Create a repost element with the reposter's info
    const reasonRepost = reason as AppBskyFeedDefs.ReasonRepost;
    const formattedDate = formatDate(reasonRepost.indexedAt || '');
    let result = `  <repost ${xmlAttrs([
      ['author_name', reasonRepost.by.displayName || ''],
      ['author_handle', reasonRepost.by.handle],
      ['reposted_at', formattedDate],
    ])}>\n`;
    
    // Format the original post (without the repost type)
    const types = determinePostType(post);
    const bskyUrl = createBskyUrl(post.uri, post.author.handle);
    const record = post.record as AppBskyFeedPost.Record;
    const postDate = formatDate(record.createdAt);
    
    // Add the post inside the repost
    result += `    <post ${xmlAttrs([
      ['type', types.join(',')],
      ['uri', post.uri],
      ['bsky_url', bskyUrl],
      ['author_name', post.author.displayName || ''],
      ['author_handle', post.author.handle],
      ['posted_at', postDate],
    ])}>\n`;
    result += `      <content>\n        ${facetsToMarkdown(record.text, record.facets)}\n      </content>\n`;
    
    // Add embeds
    result += formatEmbeds(post, '      ');
    
    // Add engagement metrics info (without Posted: prefix)
    result += `      \n      Engagement: ${post.likeCount} likes, ${post.repostCount} reposts, ${post.replyCount} replies${post.quoteCount ? ', ' + post.quoteCount + ' quotes' : ''}\n`;
    
    // Close the post and repost tags
    result += `    </post>\n`;
    result += `  </repost>`;
    
    return result;
  }
  
  // For non-reposts, continue with normal formatting
  const types = determinePostType(post);
  const bskyUrl = createBskyUrl(post.uri, post.author.handle);
  const record = post.record as AppBskyFeedPost.Record;
  const postDate = formatDate(record.createdAt);
  
  // Start building the post tag with all the attributes
  let postAttrs = xmlAttrs([
    ['type', types.join(',')],
    ['uri', post.uri],
    ['bsky_url', bskyUrl],
    ['author_name', post.author.displayName || ''],
    ['author_handle', post.author.handle],
    ['posted_at', postDate],
  ]);
  
  // Add reply_to attribute if this is a reply
  if (reply && types.includes('reply') && reply.parent.$type === 'app.bsky.feed.defs#postView') {
    const parentUri = (reply.parent as AppBskyFeedDefs.PostView).uri;
    postAttrs += ` ${xmlAttrs([['reply_to', parentUri]])}`;
  }
  
  // Start the post tag with all attributes
  let result = `  <post ${postAttrs}>\n`;
  
  // Add post content
  result += `    <content>\n      ${facetsToMarkdown(record.text, record.facets)}\n    </content>\n`;
  
  // Handle quote posts
  if (post.embed && post.embed.$type === 'app.bsky.embed.record#view') {
    const embedRecord = post.embed as AppBskyEmbedRecord.View;
    if (embedRecord.record && embedRecord.record.$type === 'app.bsky.embed.record#viewRecord') {
      const recordView = embedRecord.record as AppBskyEmbedRecord.ViewRecord;
      const quotedUrl = createBskyUrl(recordView.uri, recordView.author.handle);
      const quotedRecord = recordView.value as { text: string; createdAt: string };
      const quotedPostDate = formatDate(quotedRecord.createdAt);
      result += `    \n    <quoted_post ${xmlAttrs([
        ['uri', recordView.uri],
        ['bsky_url', quotedUrl],
        ['author_name', recordView.author.displayName || ''],
        ['author_handle', recordView.author.handle],
        ['posted_at', quotedPostDate],
      ])}>\n`;
      result += `      <content>\n        ${facetsToMarkdown(quotedRecord.text, (quotedRecord as any).facets)}\n      </content>\n`;
      result += `      \n      Engagement: ${recordView.likeCount || 0} likes, ${recordView.repostCount || 0} reposts, ${recordView.replyCount || 0} replies\n`;
      result += `    </quoted_post>\n`;
    }
  }
  
  // Add embeds
  result += formatEmbeds(post, '    ');
  
  // Add engagement metrics (without Posted: prefix)
  result += `    \n    Engagement: ${post.likeCount} likes, ${post.repostCount} reposts, ${post.replyCount} replies${post.quoteCount ? ', ' + post.quoteCount + ' quotes' : ''}\n`;
  
  // Close the post tag
  result += `  </post>`;
  
  return result;
}

/**
 * Format embeds for a post (extracted to a helper function)
 */
function formatEmbeds(post: AppBskyFeedDefs.PostView, indentation: string = ''): string {
  let result = '';
  
  if (post.embed) {
    // Images
    if (post.embed.$type === 'app.bsky.embed.images#view') {
      const imagesEmbed = post.embed as AppBskyEmbedImages.View;
      if (imagesEmbed.images) {
        imagesEmbed.images.forEach((image) => {
          result += `${indentation}\n${indentation}<embed ${xmlAttrs([['type', 'image']])}>\n`;
          result += `${indentation}  Image description: "${escapeXml(image.alt || 'No description provided')}"\n`;
          result += `${indentation}  Image URL: ${image.fullsize || image.thumb || ''}\n`;
          result += `${indentation}</embed>\n`;
        });
      }
    } 
    // External links
    else if (post.embed.$type === 'app.bsky.embed.external#view') {
      const externalEmbed = post.embed as AppBskyEmbedExternal.View;
      if (externalEmbed.external) {
        result += `${indentation}\n${indentation}<embed ${xmlAttrs([['type', 'link']])}>\n`;
        result += `${indentation}  Title: "${escapeXml(externalEmbed.external.title)}"\n`;
        result += `${indentation}  URL: ${externalEmbed.external.uri}\n`;
        result += `${indentation}  Description: "${escapeXml(externalEmbed.external.description)}"\n`;
        result += `${indentation}</embed>\n`;
      }
    }
    // Videos
    else if (post.embed.$type.includes('video')) {
      const videoEmbed = post.embed as AppBskyEmbedVideo.View;
      result += `${indentation}\n${indentation}<embed ${xmlAttrs([['type', 'video']])}>\n`;
      if (videoEmbed.thumbnail) {
        result += `${indentation}  Thumbnail: ${videoEmbed.thumbnail || ''}\n`;
      }
      if (videoEmbed.playlist) {
        result += `${indentation}  Playlist: ${videoEmbed.playlist || ''}\n`;
      }
      result += `${indentation}</embed>\n`;
    }
  }
  
  return result;
}

/**
 * Format replies for a post
 */
function formatReplies(feedItems: AppBskyFeedDefs.FeedViewPost[], parentUri: string): string {
  // Find direct replies to this post
  const replies = feedItems.filter(item => 
    item.reply && 
    item.reply.parent.$type === 'app.bsky.feed.defs#postView' &&
    (item.reply.parent as AppBskyFeedDefs.PostView).uri === parentUri
  );
  
  if (replies.length === 0) {
    return '';
  }
  
  let result = `\n\n    <replies>\n`;
  
  for (const reply of replies) {
    // Format the reply
    const formattedReply = formatPost(reply);
    
    // Indent the reply content to maintain hierarchy
    const indentedReply = formattedReply
      .split('\n')
      .map(line => `      ${line}`)
      .join('\n');
    
    result += indentedReply;
    
    // Check for nested replies (recursive)
    const nestedReplies = formatReplies(feedItems, reply.post.uri);
    if (nestedReplies) {
      // Add indentation to nested replies
      const indentedNestedReplies = nestedReplies
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n');
      
      // Insert before the closing post tag
      const lastPostTagIndex = indentedReply.lastIndexOf('</post>');
      result = result.substring(0, lastPostTagIndex) + indentedNestedReplies + result.substring(lastPostTagIndex);
    }
  }
  
  result += `\n    </replies>`;
  return result;
}

/**
 * Group feed items into threads
 */
function groupThreads(feedItems: AppBskyFeedDefs.FeedViewPost[]): { 
  threads: Map<string, AppBskyFeedDefs.FeedViewPost[]>, 
  standalone: AppBskyFeedDefs.FeedViewPost[] 
} {
  const threads = new Map<string, AppBskyFeedDefs.FeedViewPost[]>();
  const standalone: AppBskyFeedDefs.FeedViewPost[] = [];
  
  for (const item of feedItems) {
    if (item.reply) {
      // This is part of a thread
      const rootUri = item.reply.root.$type === 'app.bsky.feed.defs#postView' ? 
        (item.reply.root as AppBskyFeedDefs.PostView).uri : '';
      
      if (rootUri && !threads.has(rootUri)) {
        threads.set(rootUri, []);
      }
      
      if (rootUri) {
        threads.get(rootUri)?.push(item);
      }
    } else {
      // This is a standalone post
      standalone.push(item);
    }
  }
  
  return { threads, standalone };
}

/**
 * Format a complete thread
 */
function formatThread(feedItems: AppBskyFeedDefs.FeedViewPost[], rootUri: string): string {
  // Find the root post
  const rootPost = feedItems.find(item => 
    item.post.uri === rootUri || 
    (item.reply && 
     item.reply.root.$type === 'app.bsky.feed.defs#postView' &&
     (item.reply.root as AppBskyFeedDefs.PostView).uri === rootUri && 
     item.reply.parent.$type === 'app.bsky.feed.defs#postView' &&
     (item.reply.parent as AppBskyFeedDefs.PostView).uri === rootUri)
  );
  
  if (!rootPost) {
    return '';
  }
  
  // Format the root post
  let result = formatPost(rootPost);
  
  // Add replies
  const replies = formatReplies(feedItems, rootUri);
  if (replies) {
    // Insert before the closing post tag
    const lastPostTagIndex = result.lastIndexOf('</post>');
    // If the post is a repost, we need to insert the replies into the nested post
    if (result.includes('<repost') && result.includes('</post>')) {
      result = result.substring(0, lastPostTagIndex) + replies + result.substring(lastPostTagIndex);
    } else {
      result = result.substring(0, lastPostTagIndex) + replies + result.substring(lastPostTagIndex);
    }
  }
  
  return result;
}

/**
 * Check if an item is a tombstone placeholder for an AI-preference-excluded post.
 */
function isAiPrefTombstone(item: any): boolean {
  return item && typeof item === 'object' && '__aiPrefExcluded' in item;
}

/**
 * Format a single tombstone placeholder into XML.
 */
function formatTombstone(tombstone: any, indent: string = ''): string {
  const originalItem = tombstone.originalItem;
  const post = originalItem?.post;
  const authorHandle = post?.author?.handle || 'unknown';
  const uri = post?.uri || '';

  return `${indent}<excluded_post ${xmlAttrs([
    ['reason', 'ai_preferences'],
    ['author_handle', authorHandle],
    ['uri', uri],
  ])}>This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>`;
}

/**
 * Preprocess multiple posts into the XML format defined in the spec.
 * Excluded posts (marked with __aiPrefExcluded) are rendered as tombstone placeholders
 * so feed order and thread structure remain consistent.
 */
export function preprocessPosts(feedItems: AppBskyFeedDefs.FeedViewPost[]): string {
  let result = '<posts>\n';

  // Separate normal items from tombstones for grouping, but track positions
  const normalItems: any[] = [];
  const tombstoneIndices: number[] = [];

  feedItems.forEach((item, idx) => {
    if (isAiPrefTombstone(item)) {
      tombstoneIndices.push(idx);
    } else {
      normalItems.push({ item, originalIndex: idx });
    }
  });

  // Group normal items into threads and standalone posts
  const { threads, standalone } = groupThreads(normalItems.map(x => x.item));

  // Format threads (with their original indices)
  const threadItems: Array<{ item: any; index: number }> = [];
  threads.forEach((items) => {
    items.forEach(item => {
      const origIdx = feedItems.indexOf(item);
      if (origIdx >= 0) threadItems.push({ item, index: origIdx });
    });
  });

  // Build ordered output by merging normal posts and tombstones at their original positions
  const allEntries: Array<{ type: 'post' | 'tombstone'; content: string; orderIndex: number }> = [];

  // Add thread posts with their original indices
  threadItems.forEach(({ item, index }) => {
    const content = formatThread([item], Object.keys(threads).find(uri => threads.get(uri)?.includes(item)) || '');
    if (content) allEntries.push({ type: 'post', content, orderIndex: index });
  });

  // Add standalone posts with their original indices
  standalone.forEach((item, i) => {
    const origIdx = feedItems.indexOf(item);
    const content = formatPost(item);
    if (content) allEntries.push({ type: 'post', content, orderIndex: origIdx >= 0 ? origIdx : i });
  });

  // Add tombstones at their original positions
  tombstoneIndices.forEach(idx => {
    const tombstone = feedItems[idx];
    const content = formatTombstone(tombstone);
    if (content) allEntries.push({ type: 'tombstone', content, orderIndex: idx });
  });

  // Sort by original index to preserve ordering
  allEntries.sort((a, b) => a.orderIndex - b.orderIndex);

  // Build final output
  const parts = allEntries.map(e => e.content);
  result += parts.join('\n\n');

  // Remove trailing newlines and add closing tag
  if (result.trim()) {
    result = result.trimEnd() + '\n</posts>';
  } else {
    result += '</posts>';
  }

  return result;
}

// For backward compatibility
export function preprocessPost(feedItem: AppBskyFeedDefs.FeedViewPost): string {
  return formatPost(feedItem);
}

// For backward compatibility
export function formatFeed(feed: { items: AppBskyFeedDefs.FeedViewPost[] }): string {
  return preprocessPosts(feed.items);
}

/**
 * Recursively filter a thread view by AI preferences.
 * Replaces excluded posts with tombstone placeholders (except the requested post).
 * Returns the filtered threadViewPost or a tombstone wrapper.
 */
export function filterThreadByAiPreferences(
  threadView: any,
  allowedDids: Map<string, boolean>,
  isRequestedPost = false
): any {
  if (!threadView || typeof threadView !== 'object') return threadView;

  const post = threadView.post;
  if (!post) return threadView;

  // Always allow the requested post regardless of preferences
  if (isRequestedPost) {
    // Still recursively filter its replies and children
    if (threadView.replies && Array.isArray(threadView.replies)) {
      threadView.replies = threadView.replies.map((r: any) =>
        filterThreadByAiPreferences(r, allowedDids, false)
      );
    }
    return threadView;
  }

  // Check if this post's author is denied
  const did = post.author?.did;
  if (did && allowedDids.get(did) === false) {
    // Replace with tombstone — preserve URI and metadata for consistency
    return {
      __aiPrefExcluded: true,
      originalItem: threadView,
      deniedCategories: [],
    };
  }

  // Allowed — recursively filter replies
  if (threadView.replies && Array.isArray(threadView.replies)) {
    threadView.replies = threadView.replies.map((r: any) =>
      filterThreadByAiPreferences(r, allowedDids, false)
    );
  }

  return threadView;
}

/**
 * Behaviour descriptor for the single `ThreadViewPost` walker below.
 *
 * This module used to carry five near-duplicate copies of that walker —
 * `formatThreadViewRecursive`, `processFilteredThreadViewChain`,
 * `processFilteredThreadViewPost`, `processThreadViewPostChain` and
 * `processThreadViewPost`. Their shared body is identical; they had drifted
 * apart in a handful of small ways that callers can observe, and the XML they
 * emit is a documented contract (docs/post-format-spec.md) asserted by tests.
 * Each difference is therefore kept as an explicit parameter instead of being
 * smoothed over, and the original entry points survive as thin wrappers.
 */
interface ThreadWalkVariation {
  /**
   * Require `$type === 'app.bsky.feed.defs#threadViewPost'` and a truthy
   * `node.post` before rendering, silently skipping anything else (the flat
   * walkers). The parent-chain walkers skip this: their nodes come from
   * `threadView.parent` and carry no `$type`, and a null entry is expected to
   * reach `node.post` and throw so it is dropped by the catch below.
   */
  strictThreadViewType: boolean;
  /** Render a node that is itself an AI-preference tombstone. */
  selfTombstone: boolean;
  /**
   * The recursive walker renders its tombstone before the `$type` guard and
   * outside the try; the chain walker does it inside the try, appends a newline,
   * and then keeps the remaining chain at the same indent. Both positions are
   * kept because they decide who swallows a throw.
   */
  strictSelfTombstonePosition: boolean;
  /** Explicit newline after the self tombstone line (chain walker only). */
  selfTombstoneNewline: boolean;
  /** Render tombstone children locally rather than leaving it to the child variation. */
  childTombstones: boolean;
  /** Explicit newline after each locally rendered tombstone child (chain walker only). */
  childTombstoneNewline: boolean;
  /** Take the `requested="true"` marker from the walker argument, not from `node.isRequestedPost`. */
  requestedFromArgument: boolean;
  /**
   * A child that is not a tombstone must have a truthy `.post` to be rendered
   * (AI-preference walkers). This is also what turns a null child into a throw
   * that drops the whole node, so the plain walkers leave it off.
   */
  childRequiresPost: boolean;
  /**
   * Gate for the `<replies>` block:
   * - `rendered`: `replies.map(...)`, drop children that came back empty, and
   *   only open `<replies>` when something is left (flat walkers). A truthy
   *   non-array `replies` throws on `.map`, dropping the whole node (the other
   *   gates test `Array.isArray` first and so ignore a truthy non-array value).
   * - `inputNonNull`: open `<replies>` only when a non-empty array still holds a
   *   non-null entry after pre-filtering nulls (AI-preference chain walker). The
   *   array test is the branch condition, so an all-null `replies` suppresses the
   *   block *and* the chain tail below it.
   * - `input`: open `<replies>` whenever the array is non-empty, even when every
   *   child renders as '' (plain walkers).
   */
  repliesGate: 'rendered' | 'inputNonNull' | 'input';
  /** Variation used for children; omitted means "this same variation". */
  child?: ThreadWalkVariation;
  /** Prefix of the `console.error` line when the node throws. */
  errorLabel: string;
}

/** Flat walker for AI-preference-filtered subtrees: tombstone children render, tombstone self does not. */
const WALK_AI_PREF_FLAT: ThreadWalkVariation = {
  strictThreadViewType: true,
  selfTombstone: false,
  strictSelfTombstonePosition: true,
  selfTombstoneNewline: false,
  childTombstones: true,
  childTombstoneNewline: false,
  requestedFromArgument: false,
  childRequiresPost: true,
  repliesGate: 'rendered',
  errorLabel: 'Error processing post',
};

/** Recursive entry point: renders tombstones at any depth and takes `requested` from the argument. */
const WALK_AI_PREF_RECURSIVE: ThreadWalkVariation = {
  ...WALK_AI_PREF_FLAT,
  selfTombstone: true,
  childTombstones: false, // children recurse here, so this variation renders their tombstones itself
  childRequiresPost: false, // silent guard: the child's own `$type` check drops foreign nodes
  requestedFromArgument: true,
};

/** Parent chain of an AI-preference-filtered thread: keeps chain flow and null-safe children. */
const WALK_AI_PREF_CHAIN: ThreadWalkVariation = {
  ...WALK_AI_PREF_FLAT,
  strictThreadViewType: false,
  selfTombstone: true,
  strictSelfTombstonePosition: false,
  selfTombstoneNewline: true,
  childTombstoneNewline: true,
  repliesGate: 'inputNonNull',
  child: WALK_AI_PREF_FLAT,
  errorLabel: 'Error processing post chain',
};

/** Flat walker for unfiltered threads: no tombstones anywhere, children rendered unguarded. */
const WALK_PLAIN_FLAT: ThreadWalkVariation = {
  strictThreadViewType: true,
  selfTombstone: false,
  strictSelfTombstonePosition: true,
  selfTombstoneNewline: false,
  childTombstones: false,
  childTombstoneNewline: false,
  requestedFromArgument: false,
  childRequiresPost: false,
  repliesGate: 'input',
  errorLabel: 'Error processing post',
};

/** Parent chain of an unfiltered thread. */
const WALK_PLAIN_CHAIN: ThreadWalkVariation = {
  ...WALK_PLAIN_FLAT,
  strictThreadViewType: false,
  child: WALK_PLAIN_FLAT,
  errorLabel: 'Error processing post chain',
};

/**
 * Render one `ThreadViewPost` node (and its subtree) into the XML thread format.
 * `chainTail` is the rest of a parent chain, which — when the node has no
 * replies of its own — is nested as `<replies>` two indent levels deeper.
 * `isRequestedPost` is only consulted when the variation reads the marker from
 * the argument (see ThreadWalkVariation.requestedFromArgument).
 */
function renderThreadViewNode(
  node: any,
  indentLevel: number,
  variation: ThreadWalkVariation,
  chainTail: any[] | null,
  isRequestedPost = false
): string {
  const indent = '  '.repeat(indentLevel);

  const isTombstoneNode = variation.selfTombstone && isAiPrefTombstone(node);

  if (isTombstoneNode && variation.strictSelfTombstonePosition) {
    let tombstoneOutput = formatTombstone(node, indent);
    if (variation.selfTombstoneNewline) tombstoneOutput += '\n';
    return tombstoneOutput;
  }

  if (variation.strictThreadViewType) {
    if (!node || node.$type !== 'app.bsky.feed.defs#threadViewPost') {
      return '';
    }

    if (!node.post) return '';
  }

  let output = '';

  try {
    if (isTombstoneNode) {
      output += formatTombstone(node, indent);
      if (variation.selfTombstoneNewline) output += '\n';

      // Still try to process remaining chain items, at this same indent
      output += renderThreadViewChain(chainTail || [], indentLevel, variation);
      return output;
    }

    const post = node.post;
    if (!post) return '';

    // Determine post type (standalone, reply, quote)
    const record = post.record as AppBskyFeedPost.Record;
    if (!record) {
      console.error('Record missing for post:', post.uri);
      return '';
    }

    const isReply = record.reply != null;
    const isQuote = post.embed?.$type === 'app.bsky.embed.record#view';

    let postType = 'standalone';
    if (isReply) postType = 'reply';
    if (isQuote) {
      postType = isReply ? 'reply,quote' : 'quote';
    }

    // Check for required fields
    if (!post.uri) {
      console.error('URI missing for post');
      return '';
    }

    if (!post.author || !post.author.handle) {
      console.error('Author or handle missing for post:', post.uri);
      return '';
    }

    // Start building post tag attributes
    let postAttrs = xmlAttrs([
      ['type', postType],
      ['uri', post.uri],
      ['bsky_url', `${BSKY_WEB_URL}/profile/${post.author.handle}/post/${post.uri.split('/').pop()}`],
      ['author_name', post.author.displayName || post.author.handle],
      ['author_handle', post.author.handle],
      ['posted_at', new Date(post.indexedAt || record.createdAt).toLocaleString()],
    ]);

    // Add reply_to attribute if it's a reply
    if (isReply && record.reply && record.reply.parent && record.reply.parent.uri) {
      postAttrs += ` ${xmlAttrs([['reply_to', record.reply.parent.uri]])}`;
    }

    // If this is the originally requested post, mark it
    if (variation.requestedFromArgument ? isRequestedPost : node.isRequestedPost) {
      postAttrs += ` ${xmlAttrs([['requested', 'true']])}`;
    }

    // Format the post opening tag with all attributes
    output += `${indent}<post ${postAttrs}>\n`;

    // Add content, using facetsToMarkdown to properly handle links, mentions, hashtags
    output += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets)}\n${indent}  </content>\n`;

    // Add quoted post if present
    if (isQuote && post.embed && post.embed.record) {
      const quoted = post.embed.record;
      if (quoted.uri && quoted.author && quoted.author.handle) {
        output += `${indent}  <quoted_post ${xmlAttrs([
          ['uri', quoted.uri],
          ['bsky_url', `${BSKY_WEB_URL}/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}`],
          ['author_name', quoted.author.displayName || quoted.author.handle],
          ['author_handle', quoted.author.handle],
          ['posted_at', new Date(quoted.indexedAt || Date.now()).toLocaleString()],
        ])}>\n`;

        // Use facetsToMarkdown for quoted content as well
        output += `${indent}    <content>\n${indent}      ${facetsToMarkdown((quoted.value && quoted.value.text) || '', (quoted.value && quoted.value.facets) || [])}\n${indent}    </content>\n`;

        // Add engagement metrics for quoted post
        if (quoted.likeCount || quoted.repostCount || quoted.replyCount) {
          output += `${indent}    Engagement: ${quoted.likeCount || 0} likes, ${quoted.repostCount || 0} reposts, ${quoted.replyCount || 0} replies`;
          if (quoted.quoteCount) output += `, ${quoted.quoteCount} quotes`;
          output += '\n';
        }

        output += `${indent}  </quoted_post>\n`;
      }
    }

    // Add embeds if present
    if (post.embed && post.embed.$type !== 'app.bsky.embed.record#view') {
      // Handle images
      if (post.embed.$type === 'app.bsky.embed.images#view') {
        const images = post.embed.images || [];
        for (const image of images) {
          if (!image) continue;
          output += `${indent}  <embed ${xmlAttrs([['type', 'image']])}>\n`;
          if (image.alt) {
            output += `${indent}    Image description: "${escapeXml(image.alt)}"\n`;
          }
          if (image.fullsize || image.thumb) {
            output += `${indent}    URL: ${image.fullsize || image.thumb}\n`;
          }
          output += `${indent}  </embed>\n`;
        }
      }
      // Handle external links
      else if (post.embed.$type === 'app.bsky.embed.external#view' && post.embed.external) {
        output += `${indent}  <embed ${xmlAttrs([['type', 'link']])}>\n`;
        if (post.embed.external.title) {
          output += `${indent}    Title: "${escapeXml(post.embed.external.title)}"\n`;
        }
        if (post.embed.external.uri) {
          output += `${indent}    URL: ${post.embed.external.uri}\n`;
        }
        if (post.embed.external.description) {
          output += `${indent}    Description: "${escapeXml(post.embed.external.description)}"\n`;
        }
        if (post.embed.external.thumb) {
          output += `${indent}    Thumbnail: ${post.embed.external.thumb}\n`;
        }
        output += `${indent}  </embed>\n`;
      }
      // Handle videos
      else if (post.embed.$type === 'app.bsky.embed.video#view' && post.embed.video) {
        output += `${indent}  <embed ${xmlAttrs([['type', 'video']])}>\n`;
        if (post.embed.video.alt) {
          output += `${indent}    Video description: ${escapeXml(post.embed.video.alt)}\n`;
        }
        if (post.embed.video.thumb) {
          output += `${indent}    Thumbnail: ${post.embed.video.thumb}\n`;
        }
        if (post.embed.video.url) {
          output += `${indent}    URL: ${post.embed.video.url}\n`;
        }
        output += `${indent}  </embed>\n`;
      }
    }

    // Add engagement metrics
    if (post.likeCount || post.repostCount || post.replyCount) {
      output += `${indent}  Engagement: ${post.likeCount || 0} likes, ${post.repostCount || 0} reposts, ${post.replyCount || 0} replies`;
      if (post.quoteCount) output += `, ${post.quoteCount} quotes`;
      output += '\n';
    }

    const childVariation = variation.child ?? variation;

    const renderChild = (child: any): string => {
      if (variation.childTombstones && isAiPrefTombstone(child)) {
        return (
          formatTombstone(child, indent + '    ') +
          (variation.childTombstoneNewline ? '\n' : '')
        );
      }
      if (variation.childRequiresPost && !child.post) return '';
      return renderThreadViewNode(child, indentLevel + 2, childVariation, null, false);
    };

    if (variation.repliesGate === 'rendered') {
      // Map first, then drop the children that produced nothing; `<replies>` only
      // opens when at least one child survived. A non-array `replies` throws here
      // and takes the whole node with it — that is the original behaviour.
      const renderedReplies = (node.replies ? node.replies.map(renderChild) : []).filter(Boolean);

      if (renderedReplies.length > 0) {
        output += `${indent}  <replies>\n`;
        for (const reply of renderedReplies) {
          output += reply;
        }
        output += `${indent}  </replies>\n`;
      }
    } else if (node.replies && Array.isArray(node.replies) && node.replies.length > 0) {
      const children =
        variation.repliesGate === 'inputNonNull'
          ? node.replies.filter((r: any) => r !== null && r !== undefined)
          : node.replies;

      if (children.length > 0) {
        output += `${indent}  <replies>\n`;
        for (const reply of children) {
          output += renderChild(reply);
        }
        output += `${indent}  </replies>\n`;
      }
    }
    // If this is not the last post in the chain, add the next post as a reply
    else if (chainTail && chainTail.length > 0) {
      output += `${indent}  <replies>\n`;
      output += renderThreadViewChain(chainTail, indentLevel + 2, variation);
      output += `${indent}  </replies>\n`;
    }

    output += `${indent}</post>\n`;
  } catch (error) {
    console.error(`${variation.errorLabel}: ${error instanceof Error ? error.message : String(error)}`);
    return ''; // Skip this post if there's an error
  }

  return output;
}

/**
 * Render the head of a parent chain and hand the remaining entries to the node
 * renderer, which nests them as `<replies>` when the head has no replies of its
 * own. An empty chain renders as nothing.
 */
function renderThreadViewChain(postChain: any[], indentLevel: number, variation: ThreadWalkVariation): string {
  if (!postChain || !postChain.length) {
    return '';
  }

  return renderThreadViewNode(postChain[0], indentLevel, variation, postChain.slice(1), false);
}

/**
 * Recursively format a thread view (recursive structure from getPostThread).
 * Handles both normal posts and tombstone placeholders.
 */
function formatThreadViewRecursive(
  threadView: any,
  indentLevel: number,
  isRequestedPost = false
): string {
  return renderThreadViewNode(threadView, indentLevel, WALK_AI_PREF_RECURSIVE, null, isRequestedPost);
}

/**
 * Format a post thread according to our format spec, with AI preference filtering.
 * Excluded posts (except the requested one) are replaced with tombstone placeholders.
 */
export function formatPostThreadWithAiPrefs(
  threadView: any,
  allowedDids: Map<string, boolean>,
  allowRequestedPost: boolean = true
): string {
  if (!threadView || typeof threadView !== 'object') {
    return '<posts>\n  <error>No thread data available</error>\n</posts>';
  }

  // Handle case where threadView is already a tombstone
  if ('__aiPrefExcluded' in threadView) {
    return `<posts>\n${formatTombstone(threadView, '  ')}\n</posts>`;
  }

  // Start building the posts XML container
  let output = "<posts>\n";

  // Check if this post has parents that we need to process first
  if (threadView.parent) {
    // We need to find the root of the conversation by traversing parent references
    let currentThreadView = threadView;
    const parentChain: any[] = [];

    // Collect all parents in the chain (including the original post)
    parentChain.push(threadView);
    while (currentThreadView.parent) {
      parentChain.unshift(currentThreadView.parent); // Add parents to the front to maintain hierarchy
      currentThreadView = currentThreadView.parent;
    }

    // Mark the originally requested post
    threadView.isRequestedPost = true;

    // Filter each post in the chain by AI preferences
    const filteredChain = parentChain.map((pv: any) => {
      const isReq = pv === threadView || pv.isRequestedPost;
      const allowThis = isReq ? allowRequestedPost : false;
      return filterThreadByAiPreferences(pv, allowedDids, allowThis);
    });

    // Process the filtered chain
    output += processFilteredThreadViewChain(filteredChain, 0);
  } else {
    // No parents, just process the given thread
    threadView.isRequestedPost = true;
    const filtered = filterThreadByAiPreferences(threadView, allowedDids, allowRequestedPost);
    if (filtered && typeof filtered === 'object' && '__aiPrefExcluded' in filtered) {
      output += formatTombstone(filtered, '  ') + '\n';
    } else {
      output += formatThreadViewRecursive(filtered, 0, allowRequestedPost);
    }
  }

  // Close the posts container
  output += "</posts>";

  return output;
}

/**
 * Process a chain of (possibly filtered) thread view posts with parent-child relationships.
 */
function processFilteredThreadViewChain(postChain: any[], indentLevel: number): string {
  return renderThreadViewChain(postChain, indentLevel, WALK_AI_PREF_CHAIN);
}

/**
 * Format a post thread according to our format spec
 */
export function formatPostThread(threadView: any): string {
  // Start building the posts XML container
  let output = "<posts>\n";
  
  // Check if this post has parents that we need to process first
  if (threadView.parent) {
    // We need to find the root of the conversation by traversing parent references
    let currentThreadView = threadView;
    const parentChain = [];
    
    // Collect all parents in the chain (including the original post)
    parentChain.push(threadView);
    while (currentThreadView.parent) {
      parentChain.unshift(currentThreadView.parent); // Add parents to the front to maintain hierarchy
      currentThreadView = currentThreadView.parent;
    }
    
    // Mark the originally requested post
    threadView.isRequestedPost = true;
    
    // Since we've collected the entire chain, process the root which is the first element
    output += processThreadViewPostChain(parentChain, 0);
  } else {
    // No parents, just process the given thread
    // Mark this as the requested post
    threadView.isRequestedPost = true;
    output += processThreadViewPost(threadView, 0);
  }
  
  // Close the posts container
  output += "</posts>";
  
  return output;
}

/**
 * Process a chain of posts with parent-child relationships
 * This is used for the parent chain in getPostThread response
 */
function processThreadViewPostChain(postChain: any[], indentLevel: number): string {
  return renderThreadViewChain(postChain, indentLevel, WALK_PLAIN_CHAIN);
}

/**
 * Process a single post and all of its replies in the thread
 */
export function processThreadViewPost(threadViewPost: any, indentLevel: number): string {
  return renderThreadViewNode(threadViewPost, indentLevel, WALK_PLAIN_FLAT, null, false);
}



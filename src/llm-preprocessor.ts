// Implements the spec described in /POST_FORMAT_SPEC.md
import { formatISO9075 } from 'date-fns';
import type { 
  AppBskyFeedDefs,
  AppBskyEmbedImages,
  AppBskyEmbedVideo,
  AppBskyEmbedExternal,
  AppBskyEmbedRecord,
  AppBskyActorDefs,
  AppBskyFeedPost
} from '@atproto/api';
import { RichText } from '@atproto/api';
import { escapeXml } from './utils.js';

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
      markdown += `[${segment.text}](https://bsky.app/profile/${segment.mention?.did})`;
    } else if (segment.isTag()) {
      markdown += `#${segment.tag?.tag}`;
    } else {
      markdown += segment.text;
    }
  }
  
  return markdown;
}

/**
 * Formats a date to a human-readable format
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return formatISO9075(date).replace('T', ', ');
  } catch (e) {
    return dateString;
  }
}

/**
 * Creates a Bluesky URL from a URI
 */
function createBskyUrl(uri: string, handle?: string): string {
  try {
    const parts = uri.split('/');
    const did = parts[2];
    const rkey = parts[parts.length - 1];
    return `https://bsky.app/profile/${handle || did}/post/${rkey}`;
  } catch (e) {
    return '';
  }
}

/**
 * Determines the post type based on its properties
 */
function determinePostType(post: AppBskyFeedDefs.PostView, reason?: AppBskyFeedDefs.ReasonRepost): string[] {
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
    let result = `  <repost author_name="${reasonRepost.by.displayName || ''}" author_handle="${reasonRepost.by.handle}" reposted_at="${formattedDate}">\n`;
    
    // Format the original post (without the repost type)
    const types = determinePostType(post);
    const bskyUrl = createBskyUrl(post.uri, post.author.handle);
    const record = post.record as AppBskyFeedPost.Record;
    const postDate = formatDate(record.createdAt);
    
    // Add the post inside the repost
    result += `    <post type="${types.join(',')}" uri="${post.uri}" bsky_url="${bskyUrl}" author_name="${post.author.displayName || ''}" author_handle="${post.author.handle}" posted_at="${postDate}">\n`;
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
  const types = determinePostType(post, reason as AppBskyFeedDefs.ReasonRepost);
  const bskyUrl = createBskyUrl(post.uri, post.author.handle);
  const record = post.record as AppBskyFeedPost.Record;
  const postDate = formatDate(record.createdAt);
  
  // Start building the post tag with all the attributes
  let postAttrs = `type="${types.join(',')}" uri="${post.uri}" bsky_url="${bskyUrl}" author_name="${post.author.displayName || ''}" author_handle="${post.author.handle}" posted_at="${postDate}"`;
  
  // Add reply_to attribute if this is a reply
  if (reply && types.includes('reply') && reply.parent.$type === 'app.bsky.feed.defs#postView') {
    const parentUri = (reply.parent as AppBskyFeedDefs.PostView).uri;
    postAttrs += ` reply_to="${parentUri}"`;
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
      result += `    \n    <quoted_post uri="${recordView.uri}" bsky_url="${quotedUrl}" author_name="${recordView.author.displayName || ''}" author_handle="${recordView.author.handle}" posted_at="${quotedPostDate}">\n`;
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
          result += `${indentation}\n${indentation}<embed type="image">\n`;
          result += `${indentation}  Image description: "${image.alt || 'No description provided'}"\n`;
          result += `${indentation}  Image URL: ${image.fullsize || image.thumb || ''}\n`;
          result += `${indentation}</embed>\n`;
        });
      }
    } 
    // External links
    else if (post.embed.$type === 'app.bsky.embed.external#view') {
      const externalEmbed = post.embed as AppBskyEmbedExternal.View;
      if (externalEmbed.external) {
        result += `${indentation}\n${indentation}<embed type="link">\n`;
        result += `${indentation}  Title: "${externalEmbed.external.title}"\n`;
        result += `${indentation}  URL: ${externalEmbed.external.uri}\n`;
        result += `${indentation}  Description: "${externalEmbed.external.description}"\n`;
        result += `${indentation}</embed>\n`;
      }
    }
    // Videos
    else if (post.embed.$type.includes('video')) {
      const videoEmbed = post.embed as AppBskyEmbedVideo.View;
      result += `${indentation}\n${indentation}<embed type="video">\n`;
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

  return `${indent}<excluded_post reason="ai_preferences" author_handle="${escapeXml(authorHandle)}" uri="${escapeXml(uri)}">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>`;
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
  threads.forEach((items, rootUri) => {
    items.forEach(item => {
      const origIdx = feedItems.indexOf(item);
      if (origIdx >= 0) threadItems.push({ item, index: origIdx });
    });
  });

  // Build ordered output by merging normal posts and tombstones at their original positions
  const allEntries: Array<{ type: 'post' | 'tombstone'; content: string; orderIndex: number }> = [];

  // Add thread posts with their original indices
  threadItems.forEach(({ item, index }) => {
    let content = formatThread([item], Object.keys(threads).find(uri => threads.get(uri)?.includes(item)) || '');
    if (content) allEntries.push({ type: 'post', content, orderIndex: index });
  });

  // Add standalone posts with their original indices
  standalone.forEach((item, i) => {
    const origIdx = feedItems.indexOf(item);
    let content = formatPost(item);
    if (content) allEntries.push({ type: 'post', content, orderIndex: origIdx >= 0 ? origIdx : i });
  });

  // Add tombstones at their original positions
  tombstoneIndices.forEach(idx => {
    const tombstone = feedItems[idx];
    let content = formatTombstone(tombstone);
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
 * Recursively format a thread view (recursive structure from getPostThread).
 * Handles both normal posts and tombstone placeholders.
 */
function formatThreadViewRecursive(
  threadView: any,
  indentLevel: number,
  isRequestedPost = false
): string {
  const indent = '  '.repeat(indentLevel);

  // Handle tombstones in recursive thread output
  if (threadView && typeof threadView === 'object' && '__aiPrefExcluded' in threadView) {
    const originalItem = threadView.originalItem;
    const post = originalItem?.post;
    const authorHandle = post?.author?.handle || 'unknown';
    const uri = post?.uri || '';
    return `${indent}<excluded_post reason="ai_preferences" author_handle="${escapeXml(authorHandle)}" uri="${escapeXml(uri)}">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>`;
  }

  if (!threadView || threadView.$type !== 'app.bsky.feed.defs#threadViewPost') {
    return '';
  }

  const post = threadView.post;
  if (!post) return '';

  let output = '';

  try {
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
    let postAttrs = `type="${postType}" uri="${post.uri}" bsky_url="https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}" `;
    postAttrs += `author_name="${escapeXml(post.author.displayName || post.author.handle)}" author_handle="${post.author.handle}" `;
    postAttrs += `posted_at="${new Date(post.indexedAt || record.createdAt).toLocaleString()}"`;

    // Add reply_to attribute if it's a reply
    if (isReply && record.reply && record.reply.parent && record.reply.parent.uri) {
      postAttrs += ` reply_to="${record.reply.parent.uri}"`;
    }

    // If this is the originally requested post, mark it
    if (isRequestedPost) {
      postAttrs += ` requested="true"`;
    }

    // Format the post opening tag with all attributes
    output += `${indent}<post ${postAttrs}>\n`;

    // Add content, using facetsToMarkdown to properly handle links, mentions, hashtags
    output += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets)}\n${indent}  </content>\n`;

    // Add quoted post if present
    if (isQuote && post.embed && post.embed.record) {
      const quoted = post.embed.record;
      if (quoted.uri && quoted.author && quoted.author.handle) {
        output += `${indent}  <quoted_post uri="${quoted.uri}" `;
        output += `bsky_url="https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}" `;
        output += `author_name="${escapeXml(quoted.author.displayName || quoted.author.handle)}" `;
        output += `author_handle="${quoted.author.handle}" `;
        output += `posted_at="${new Date(quoted.indexedAt || Date.now()).toLocaleString()}">\n`;

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
          output += `${indent}  <embed type="image">\n`;
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
        output += `${indent}  <embed type="link">\n`;
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
        output += `${indent}  <embed type="video">\n`;
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

    // Process replies recursively if present — filter by AI prefs first
    const filteredReplies = threadView.replies
      ? threadView.replies.map((r: any) => formatThreadViewRecursive(r, indentLevel + 2, false))
      : [];
    const validReplies = filteredReplies.filter(Boolean);

    if (validReplies.length > 0) {
      output += `${indent}  <replies>\n`;
      for (const reply of validReplies) {
        output += reply;
      }
      output += `${indent}  </replies>\n`;
    }

    output += `${indent}</post>\n`;
  } catch (error) {
    console.error(`Error processing post: ${error instanceof Error ? error.message : String(error)}`);
    return ''; // Skip this post if there's an error
  }

  return output;
}

/**
 * Format a post thread according to our format spec, with AI preference filtering.
 * Excluded posts (except the requested one) are replaced with tombstone placeholders.
 */
export function formatPostThreadWithAiPrefs(
  threadView: any,
  allowedDids: Map<string, boolean>
): string {
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

    // Filter each post in the chain by AI preferences (requested post is always allowed)
    const filteredChain = parentChain.map((pv: any, idx: number) => {
      if (idx === 0 && pv.isRequestedPost) {
        return filterThreadByAiPreferences(pv, allowedDids, true);
      }
      // Parent posts are also always shown for context
      return filterThreadByAiPreferences(pv, allowedDids, false);
    });

    // Process the filtered chain
    output += processFilteredThreadViewChain(filteredChain, 0);
  } else {
    // No parents, just process the given thread
    // Mark this as the requested post and always allow it
    threadView.isRequestedPost = true;
    const filtered = filterThreadByAiPreferences(threadView, allowedDids, true);
    output += formatThreadViewRecursive(filtered, 0, true);
  }

  // Close the posts container
  output += "</posts>";

  return output;
}

/**
 * Process a chain of (possibly filtered) thread view posts with parent-child relationships.
 */
function processFilteredThreadViewChain(postChain: any[], indentLevel: number): string {
  if (!postChain || !postChain.length) {
    return '';
  }

  // Start with the root post
  const rootPost = postChain[0];
  const indent = '  '.repeat(indentLevel);
  let output = '';

  try {
    // Handle tombstones in chain
    if (rootPost && typeof rootPost === 'object' && '__aiPrefExcluded' in rootPost) {
      const originalItem = rootPost.originalItem;
      const post = originalItem?.post;
      const authorHandle = post?.author?.handle || 'unknown';
      const uri = post?.uri || '';
      output += `${indent}<excluded_post reason="ai_preferences" author_handle="${escapeXml(authorHandle)}" uri="${escapeXml(uri)}">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>\n`;

      // Still try to process remaining chain items
      if (postChain.length > 1) {
        output += processFilteredThreadViewChain(postChain.slice(1), indentLevel);
      }
      return output;
    }

    const post = rootPost.post;
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
    let postAttrs = `type="${postType}" uri="${post.uri}" bsky_url="https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}" `;
    postAttrs += `author_name="${escapeXml(post.author.displayName || post.author.handle)}" author_handle="${post.author.handle}" `;
    postAttrs += `posted_at="${new Date(post.indexedAt || record.createdAt).toLocaleString()}"`;

    // Add reply_to attribute if it's a reply
    if (isReply && record.reply && record.reply.parent && record.reply.parent.uri) {
      postAttrs += ` reply_to="${record.reply.parent.uri}"`;
    }

    // If this is the originally requested post, mark it
    if (rootPost.isRequestedPost) {
      postAttrs += ` requested="true"`;
    }

    // Format the post opening tag with all attributes
    output += `${indent}<post ${postAttrs}>\n`;

    // Add content, using facetsToMarkdown to properly handle links, mentions, hashtags
    output += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets)}\n${indent}  </content>\n`;

    // Add quoted post if present
    if (isQuote && post.embed && post.embed.record) {
      const quoted = post.embed.record;
      if (quoted.uri && quoted.author && quoted.author.handle) {
        output += `${indent}  <quoted_post uri="${quoted.uri}" `;
        output += `bsky_url="https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}" `;
        output += `author_name="${escapeXml(quoted.author.displayName || quoted.author.handle)}" `;
        output += `author_handle="${quoted.author.handle}" `;
        output += `posted_at="${new Date(quoted.indexedAt || Date.now()).toLocaleString()}">\n`;

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
          output += `${indent}  <embed type="image">\n`;
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
        output += `${indent}  <embed type="link">\n`;
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
        output += `${indent}  <embed type="video">\n`;
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

    // Handle replies: first check normal replies array (already filtered by AI prefs)
    if (rootPost.replies && Array.isArray(rootPost.replies) && rootPost.replies.length > 0) {
      const validReplies = rootPost.replies.filter((r: any) => r !== null && r !== undefined);
      if (validReplies.length > 0) {
        output += `${indent}  <replies>\n`;
        for (const reply of validReplies) {
          // Check if this is a tombstone or normal post
          if (reply && typeof reply === 'object' && '__aiPrefExcluded' in reply) {
            const originalItem = reply.originalItem;
            const p = originalItem?.post;
            const ah = p?.author?.handle || 'unknown';
            const ur = p?.uri || '';
            output += `${indent}    <excluded_post reason="ai_preferences" author_handle="${escapeXml(ah)}" uri="${escapeXml(ur)}">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>\n`;
          } else if (reply.post) {
            output += processFilteredThreadViewPost(reply, indentLevel + 2);
          }
        }
        output += `${indent}  </replies>\n`;
      }
    }

    // If this is not the last post in the chain, add the next post as a reply
    else if (postChain.length > 1) {
      const remainingChain = postChain.slice(1);
      output += `${indent}  <replies>\n`;
      output += processFilteredThreadViewChain(remainingChain, indentLevel + 2);
      output += `${indent}  </replies>\n`;
    }

    output += `${indent}</post>\n`;
  } catch (error) {
    console.error(`Error processing post chain: ${error instanceof Error ? error.message : String(error)}`);
    return ''; // Skip this post if there's an error
  }

  return output;
}

/**
 * Process a single filtered thread view post and all of its replies.
 */
function processFilteredThreadViewPost(threadViewPost: any, indentLevel: number): string {
  if (!threadViewPost || threadViewPost.$type !== 'app.bsky.feed.defs#threadViewPost') {
    return '';
  }

  const post = threadViewPost.post;
  if (!post) return '';

  const indent = '  '.repeat(indentLevel);
  let output = '';

  try {
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
    let postAttrs = `type="${postType}" uri="${post.uri}" bsky_url="https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}" `;
    postAttrs += `author_name="${escapeXml(post.author.displayName || post.author.handle)}" author_handle="${post.author.handle}" `;
    postAttrs += `posted_at="${new Date(post.indexedAt || record.createdAt).toLocaleString()}"`;

    // Add reply_to attribute if it's a reply
    if (isReply && record.reply && record.reply.parent && record.reply.parent.uri) {
      postAttrs += ` reply_to="${record.reply.parent.uri}"`;
    }

    // If this is the originally requested post, mark it
    if (threadViewPost.isRequestedPost) {
      postAttrs += ` requested="true"`;
    }

    // Format the post opening tag with all attributes
    output += `${indent}<post ${postAttrs}>\n`;

    // Add content, using facetsToMarkdown to properly handle links, mentions, hashtags
    output += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets)}\n${indent}  </content>\n`;

    // Add quoted post if present
    if (isQuote && post.embed && post.embed.record) {
      const quoted = post.embed.record;
      if (quoted.uri && quoted.author && quoted.author.handle) {
        output += `${indent}  <quoted_post uri="${quoted.uri}" `;
        output += `bsky_url="https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}" `;
        output += `author_name="${escapeXml(quoted.author.displayName || quoted.author.handle)}" `;
        output += `author_handle="${quoted.author.handle}" `;
        output += `posted_at="${new Date(quoted.indexedAt || Date.now()).toLocaleString()}">\n`;

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
          output += `${indent}  <embed type="image">\n`;
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
        output += `${indent}  <embed type="link">\n`;
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
        output += `${indent}  <embed type="video">\n`;
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

    // Process replies recursively if present — filter by AI prefs first
    const filteredReplies = threadViewPost.replies
      ? threadViewPost.replies.map((r: any) => {
          if (r && typeof r === 'object' && '__aiPrefExcluded' in r) {
            // Tombstone in replies
            const originalItem = r.originalItem;
            const p = originalItem?.post;
            const ah = p?.author?.handle || 'unknown';
            const ur = p?.uri || '';
            return `${indent}    <excluded_post reason="ai_preferences" author_handle="${escapeXml(ah)}" uri="${escapeXml(ur)}">This post is hidden because the author has disabled AI inference/training in their Bluesky preferences.</excluded_post>`;
          } else if (r.post) {
            return processFilteredThreadViewPost(r, indentLevel + 2);
          }
          return '';
        })
      : [];
    const validReplies = filteredReplies.filter(Boolean);

    if (validReplies.length > 0) {
      output += `${indent}  <replies>\n`;
      for (const reply of validReplies) {
        output += reply;
      }
      output += `${indent}  </replies>\n`;
    }

    output += `${indent}</post>\n`;
  } catch (error) {
    console.error(`Error processing post: ${error instanceof Error ? error.message : String(error)}`);
    return ''; // Skip this post if there's an error
  }

  return output;
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
  if (!postChain || !postChain.length) {
    return '';
  }
  
  // Start with the root post
  const rootPost = postChain[0];
  const indent = '  '.repeat(indentLevel);
  let output = '';
  
  try {
    const post = rootPost.post;
    if (!post) return '';
    
    // Determine post type (standalone, reply, quote)
    const record = post.record;
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
    let postAttrs = `type="${postType}" uri="${post.uri}" bsky_url="https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}" `;
    postAttrs += `author_name="${escapeXml(post.author.displayName || post.author.handle)}" author_handle="${post.author.handle}" `;
    postAttrs += `posted_at="${new Date(post.indexedAt || record.createdAt).toLocaleString()}"`;
    
    // Add reply_to attribute if it's a reply
    if (isReply && record.reply && record.reply.parent && record.reply.parent.uri) {
      postAttrs += ` reply_to="${record.reply.parent.uri}"`;
    }
    
    // If this is the originally requested post, mark it
    if (rootPost.isRequestedPost) {
      postAttrs += ` requested="true"`;
    }
    
    // Format the post opening tag with all attributes
    output += `${indent}<post ${postAttrs}>\n`;
    
    // Add content, using facetsToMarkdown to properly handle links, mentions, hashtags
    output += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets)}\n${indent}  </content>\n`;
    
    // Add quoted post if present
    if (isQuote && post.embed && post.embed.record) {
      const quoted = post.embed.record;
      if (quoted.uri && quoted.author && quoted.author.handle) {
        output += `${indent}  <quoted_post uri="${quoted.uri}" `;
        output += `bsky_url="https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}" `;
        output += `author_name="${escapeXml(quoted.author.displayName || quoted.author.handle)}" `;
        output += `author_handle="${quoted.author.handle}" `;
        output += `posted_at="${new Date(quoted.indexedAt || Date.now()).toLocaleString()}">\n`;
        
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
          output += `${indent}  <embed type="image">\n`;
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
        output += `${indent}  <embed type="link">\n`;
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
        output += `${indent}  <embed type="video">\n`;
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
    
    // Handle replies: first check normal replies array
    if (rootPost.replies && Array.isArray(rootPost.replies) && rootPost.replies.length > 0) {
      output += `${indent}  <replies>\n`;
      for (const reply of rootPost.replies) {
        output += processThreadViewPost(reply, indentLevel + 2);
      }
      output += `${indent}  </replies>\n`;
    } 
    // If this is not the last post in the chain, add the next post as a reply
    else if (postChain.length > 1) {
      output += `${indent}  <replies>\n`;
      const remainingChain = postChain.slice(1);
      output += processThreadViewPostChain(remainingChain, indentLevel + 2);
      output += `${indent}  </replies>\n`;
    }
    
    output += `${indent}</post>\n`;
  } catch (error) {
    console.error(`Error processing post chain: ${error instanceof Error ? error.message : String(error)}`);
    return ''; // Skip this post if there's an error
  }
  
  return output;
}

/**
 * Process a single post and all of its replies in the thread
 */
export function processThreadViewPost(threadViewPost: any, indentLevel: number): string {
  if (!threadViewPost || threadViewPost.$type !== 'app.bsky.feed.defs#threadViewPost') {
    return '';
  }
  
  const post = threadViewPost.post;
  if (!post) return '';
  
  const indent = '  '.repeat(indentLevel);
  let output = '';
  
  try {
    // Determine post type (standalone, reply, quote)
    const record = post.record;
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
    let postAttrs = `type="${postType}" uri="${post.uri}" bsky_url="https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}" `;
    postAttrs += `author_name="${escapeXml(post.author.displayName || post.author.handle)}" author_handle="${post.author.handle}" `;
    postAttrs += `posted_at="${new Date(post.indexedAt || record.createdAt).toLocaleString()}"`;
    
    // Add reply_to attribute if it's a reply
    if (isReply && record.reply && record.reply.parent && record.reply.parent.uri) {
      postAttrs += ` reply_to="${record.reply.parent.uri}"`;
    }
    
    // If this is the originally requested post, mark it
    if (threadViewPost.isRequestedPost) {
      postAttrs += ` requested="true"`;
    }
    
    // Format the post opening tag with all attributes
    output += `${indent}<post ${postAttrs}>\n`;
    
    // Add content, using facetsToMarkdown to properly handle links, mentions, hashtags
    output += `${indent}  <content>\n${indent}    ${facetsToMarkdown(record.text || '', record.facets)}\n${indent}  </content>\n`;
    
    // Add quoted post if present
    if (isQuote && post.embed && post.embed.record) {
      const quoted = post.embed.record;
      if (quoted.uri && quoted.author && quoted.author.handle) {
        output += `${indent}  <quoted_post uri="${quoted.uri}" `;
        output += `bsky_url="https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}" `;
        output += `author_name="${escapeXml(quoted.author.displayName || quoted.author.handle)}" `;
        output += `author_handle="${quoted.author.handle}" `;
        output += `posted_at="${new Date(quoted.indexedAt || Date.now()).toLocaleString()}">\n`;
        
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
          output += `${indent}  <embed type="image">\n`;
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
        output += `${indent}  <embed type="link">\n`;
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
        output += `${indent}  <embed type="video">\n`;
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
    
    // Process replies recursively if present
    if (threadViewPost.replies && Array.isArray(threadViewPost.replies) && threadViewPost.replies.length > 0) {
      output += `${indent}  <replies>\n`;
      for (const reply of threadViewPost.replies) {
        output += processThreadViewPost(reply, indentLevel + 2);
      }
      output += `${indent}  </replies>\n`;
    }
    
    output += `${indent}</post>\n`;
  } catch (error) {
    console.error(`Error processing post: ${error instanceof Error ? error.message : String(error)}`);
    return ''; // Skip this post if there's an error
  }
  
  return output;
}



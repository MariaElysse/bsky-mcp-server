/**
 * Thread Context module — fetches complete conversation threads for posts where
 * the agent was mentioned, with AI preference filtering.
 */

import { AtpAgent } from '@atproto/api';
import {
  batchCheckAiPreferences,
  filterThreadByAiPreferences as aiPrefFilterThread,
  getDidsFromThread,
} from './ai-preferences.js';
import { formatPostThread } from './llm-preprocessor.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of fetching and filtering a thread context */
export interface ThreadContextResult {
  /** The filtered thread view (may be null on error) */
  thread: any | null;
  /** Unique DIDs of all participants in the thread */
  participants: string[];
  /** The URI that was mentioned / requested */
  mentionedPostUri: string;
  /** Human-readable summary for LLM consumption */
  formattedText: string;
}

// ---------------------------------------------------------------------------
// extractAllParticipants — recursively extracts unique DIDs from a thread view
// ---------------------------------------------------------------------------

/**
 * Recursively extracts unique DIDs from root, parents, and replies in a thread view.
 * Returns deduplicated array of DIDs.
 */
export function extractAllParticipants(threadView: any): string[] {
  if (!threadView || typeof threadView !== 'object') return [];

  const dids = new Set<string>();

  // Collect DID from the post itself
  const post = threadView.post;
  if (post?.author?.did) {
    dids.add(post.author.did);
  }

  // Recurse into parent chain
  if (threadView.parent && typeof threadView.parent === 'object') {
    for (const did of extractAllParticipants(threadView.parent)) {
      dids.add(did);
    }
  }

  // Recurse into replies
  if (threadView.replies && Array.isArray(threadView.replies)) {
    for (const reply of threadView.replies) {
      if (reply && typeof reply === 'object') {
        for (const did of extractAllParticipants(reply)) {
          dids.add(did);
        }
      }
    }
  }

  return Array.from(dids);
}

// ---------------------------------------------------------------------------
// formatThreadForReply — isolates the branch containing a mentioned post
// ---------------------------------------------------------------------------

/**
 * Formats the specific thread context relevant to the mention.
 * Shows only the branch containing the mentioned post + its immediate context.
 * Includes author info for all participants in that branch.
 */
export function formatThreadForReply(
  threadView: any,
  mentionedPostUri: string
): ThreadContextResult {
  // Extract all participants first (before filtering)
  const participants = extractAllParticipants(threadView);

  // Format the full thread using llm-preprocessor conventions
  let formattedText = '';
  try {
    formattedText = formatPostThread(threadView);
  } catch (_err) {
    // Fallback: produce a minimal summary
    formattedText = '<posts>\n  <error>Failed to format thread</error>\n</posts>';
  }

  return {
    thread: threadView,
    participants,
    mentionedPostUri,
    formattedText,
  };
}

// ---------------------------------------------------------------------------
// fetchThreadContext — main entry point for fetching a full thread with AI prefs
// ---------------------------------------------------------------------------

/**
 * Fetches a complete conversation thread via getPostThread and applies AI
 * preference filtering. Returns formatted context suitable for LLM consumption.
 */
export async function fetchThreadContext(
  agent: AtpAgent,
  postUri: string
): Promise<ThreadContextResult> {
  try {
    // Fetch the full thread from Bluesky
    const response = await agent.app.bsky.feed.getPostThread({
      uri: postUri,
      depth: 100,
      parentHeight: 100,
    });

    if (!response.data?.thread) {
      return buildEmptyResult(postUri);
    }

    const threadView = response.data.thread;

    // Extract all participant DIDs from the raw (unfiltered) thread
    const participants = extractAllParticipants(threadView);

    // Batch-check AI preferences for all unique participants
    let allowedDids: Map<string, boolean> = new Map();
    if (participants.length > 0) {
      try {
        allowedDids = await batchCheckAiPreferences(agent, participants);
      } catch (_err) {
        // If preference check fails, allow all content (privacy-first fallback)
        for (const did of participants) {
          allowedDids.set(did, true);
        }
      }
    }

    // Apply AI preference filtering to the thread
    const filteredThread = aiPrefFilterThread(threadView, allowedDids, true);

    // Format using llm-preprocessor conventions
    let formattedText = '';
    try {
      formattedText = formatPostThread(filteredThread);
    } catch (_err) {
      formattedText = '<posts>\n  <error>Failed to format thread</error>\n</posts>';
    }

    return {
      thread: filteredThread,
      participants,
      mentionedPostUri: postUri,
      formattedText,
    };
  } catch (_err) {
    // Graceful fallback on error
    return buildEmptyResult(postUri);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an empty ThreadContextResult for error/missing cases */
function buildEmptyResult(mentionedPostUri: string): ThreadContextResult {
  return {
    thread: null,
    participants: [],
    mentionedPostUri,
    formattedText: '<posts>\n  <error>No thread data available</error>\n</posts>',
  };
}

// ---------------------------------------------------------------------------
// fetchThreadContextWithMeta — like fetchThreadContext but returns excluded count
// ---------------------------------------------------------------------------

/**
 * Fetches a full thread context and returns metadata about excluded posts.
 */
export async function fetchThreadContextWithMeta(
  agent: AtpAgent,
  postUri: string
): Promise<{ thread: string; excludedCount: number }> {
  try {
    const response = await agent.app.bsky.feed.getPostThread({
      uri: postUri,
      depth: 100,
      parentHeight: 100,
    });

    if (!response.data?.thread) {
      return { thread: '', excludedCount: 0 };
    }

    const threadView = response.data.thread;

    // Collect all DIDs from the thread for batch checking
    const allDids = extractAllParticipants(threadView);

    // Batch-check preferences
    let allowedMap: Map<string, boolean> = new Map();
    if (allDids.length > 0) {
      try {
        allowedMap = await batchCheckAiPreferences(agent, allDids);
      } catch (_err) {
        for (const did of allDids) {
          allowedMap.set(did, true);
        }
      }
    }

    // Filter the thread by AI preferences
    const filteredThread = aiPrefFilterThread(threadView, allowedMap, true);

    if (!filteredThread) {
      return { thread: '', excludedCount: allDids.length };
    }

    // Format the thread structure
    let threadData = '';
    try {
      threadData = formatPostThread(filteredThread);
    } catch (_err) {
      threadData = '<posts>\n  <error>Failed to format thread</error>\n</posts>';
    }

    return { thread: threadData, excludedCount: allDids.length };
  } catch (_err) {
    return { thread: '', excludedCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// formatPermissionSummary — human-readable summary of AI permission status
// ---------------------------------------------------------------------------

/**
 * Formats a summary of AI preference permissions for the given allowed map.
 */
export function formatPermissionSummary(allowedMap: Map<string, boolean>): string {
  const denied: string[] = [];
  const allowed: string[] = [];

  for (const [did, isAllowed] of allowedMap) {
    if (isAllowed) {
      allowed.push(did);
    } else {
      denied.push(did);
    }
  }

  let summary = `AI Preference Summary:\n`;
  summary += `  Allowed: ${allowed.length} participant(s)\n`;
  summary += `  Denied: ${denied.length} participant(s)`;

  if (denied.length > 0) {
    summary += `\n\nDenied participants:`;
    for (const did of denied) {
      summary += `\n  - ${did}`;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Utility: isolate the branch containing a specific post URI
// ---------------------------------------------------------------------------

/**
 * Recursively isolates the branch of a thread that contains the target post.
 * Returns the target subtree or branch if found, or null if not found.
 */
export function isolateBranch(threadView: any, targetUri: string): any | null {
  if (!threadView || typeof threadView !== 'object') return null;

  const post = threadView.post;
  if (post?.uri === targetUri) {
    // Found the target — clone to avoid mutating original
    return JSON.parse(JSON.stringify(threadView));
  }

  // Check parent chain
  if (threadView.parent && typeof threadView.parent === 'object') {
    const parentBranch = isolateBranch(threadView.parent, targetUri);
    if (parentBranch) {
      return parentBranch;
    }
  }

  // Check replies
  if (threadView.replies && Array.isArray(threadView.replies)) {
    for (const reply of threadView.replies) {
      const branch = isolateBranch(reply, targetUri);
      if (branch) {
        return branch;
      }
    }
  }

  return null;
}

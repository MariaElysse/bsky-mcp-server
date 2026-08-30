/**
 * Thread context retrieval module.
 *
 * Fetches complete conversation threads via app.bsky.feed.getPostThread and
 * performs comprehensive AI preference checks across all participants (root,
 * parents, replies).  Also inspects profiles/labels for explicit opt-out
 * signals so the LLM can respect a user's choice to exclude themselves from
 * inference/training.
 */

import type { AtpAgent } from '@atproto/api';
import { batchCheckAiPreferences, READ_PREFERENCES } from './ai-preferences.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single participant extracted from a thread view node. */
export interface ThreadParticipant {
  /** Bluesky DID of the author */
  did: string;
  /** Handle for display */
  handle: string;
  /** Display name */
  displayName?: string;
  /** Whether this user has opted out of AI inference/training */
  aiPrefDenied: boolean;
  /** Which categories caused denial (empty if allowed) */
  deniedCategories: string[];
}

/** Summary of a thread's participants and permission status. */
export interface ThreadPermissionSummary {
  /** All unique participants in the thread */
  participants: ThreadParticipant[];
  /** Whether any participant has opted out of AI inference/training */
  hasOptOuts: boolean;
  /** List of DIDs that denied inference or training */
  optOutDids: string[];
}

/** Full context returned by fetchThreadContext. */
export interface ThreadContext {
  /** The raw thread view from the API (may contain tombstones) */
  threadView: any;
  /** Summary of participants and their AI preference status */
  permissionSummary: ThreadPermissionSummary;
  /** Whether it is safe to generate an AI reply based on opt-out signals */
  canReplyWithAi: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum depth for getPostThread — keep generous but bounded. */
const MAX_THREAD_DEPTH = 100;
/** Maximum parent height. */
const MAX_PARENT_HEIGHT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all unique DIDs from a thread view node, along with
 * their handle and display name.
 */
function collectDidsFromThread(
  threadView: any,
  didMap = new Map<string, { handle: string; displayName?: string }>()
): Map<string, { handle: string; displayName?: string }> {
  if (!threadView || typeof threadView !== 'object') return didMap;

  const post = (threadView as any).post;
  if (post?.author?.did) {
    didMap.set(post.author.did, {
      handle: post.author.handle ?? '',
      displayName: post.author.displayName,
    });
  }

  // Recurse into parent chain
  const parent = (threadView as any).parent;
  if (parent) collectDidsFromThread(parent, didMap);

  // Recurse into replies
  const replies = (threadView as any).replies;
  if (Array.isArray(replies)) {
    for (const reply of replies) {
      collectDidsFromThread(reply, didMap);
    }
  }

  return didMap;
}

/**
 * Check whether a profile has explicit opt-out labels that signal the user
 * does not want their content used by AI systems.
 */
async function checkProfileOptOut(
  agent: any,
  did: string
): Promise<{ hasLabelOptOut: boolean; deniedCategories: string[] }> {
  try {
    const profile = await agent.getProfile({ actor: did });
    if (!profile.success) return { hasLabelOptOut: false, deniedCategories: [] };

    const labels = (profile.data as any).labels ?? [];
    const deniedCategories: string[] = [];

    for (const label of labels) {
      // Bluesky uses the "no-inference" and "no-training" labels to signal
      // that a user does not want their content used by AI systems.
      if (label.val === 'no-inference' || label.csrc === 'lex:ai:no-inference') {
        deniedCategories.push('inference');
      }
      if (label.val === 'no-training' || label.csrc === 'lex:ai:no-training') {
        deniedCategories.push('training');
      }
    }

    return {
      hasLabelOptOut: deniedCategories.length > 0,
      deniedCategories,
    };
  } catch {
    // If we can't fetch the profile, fall back to repo-based prefs only.
    return { hasLabelOptOut: false, deniedCategories: [] };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a complete conversation thread for a given post URI and perform AI
 * preference checks on all participants.
 *
 * @param agent   — authenticated AtpAgent instance (or Agent, cast as any)
 * @param uri     — AT URI of the root post (e.g. at://did:plc:.../app.bsky.feed.post/...)
 * @returns       ThreadContext with permission summary and AI-reply safety flag
 */
export async function fetchThreadContext(
  agent: any,
  uri: string
): Promise<ThreadContext> {
  // 1. Fetch the full thread from Bluesky API.
  const response = await agent.app.bsky.feed.getPostThread({
    uri,
    depth: MAX_THREAD_DEPTH,
    parentHeight: MAX_PARENT_HEIGHT,
  });

  if (!response.success) {
    throw new Error(`Failed to fetch thread for ${uri}: ${JSON.stringify(response)}`);
  }

  const threadView = response.data.thread;

  // 2. Collect all unique DIDs from the thread (root + parents + replies).
  const didMap = collectDidsFromThread(threadView);
  const dids = Array.from(didMap.keys());

  if (dids.length === 0) {
    return {
      threadView,
      permissionSummary: { participants: [], hasOptOuts: false, optOutDids: [] },
      canReplyWithAi: true, // no participants to worry about
    };
  }

  // 3. Batch-check AI preferences for all DIDs.
  const allowedMap = await batchCheckAiPreferences(agent, dids);

  // 4. For each denied DID, fetch the full record and check profile labels.
  const participants: ThreadParticipant[] = [];
  const optOutDids: string[] = [];

  for (const did of dids) {
    const allowed = allowedMap.get(did);
    let deniedCategories: string[] = [];

    if (allowed === false) {
      // Fetch the full AI preferences record to get specific categories.
      try {
        const prefsRecord = await agent.com.atproto.repo.getRecord({
          repo: did,
          collection: 'community.lexicon.preference.ai',
          rkey: 'self',
        });

        if (prefsRecord.success) {
          const raw = (prefsRecord.data as any).value;
          const prefs = raw?.preferences ?? {};
          for (const cat of READ_PREFERENCES) {
            if ((prefs[cat] as { allow?: boolean })?.allow === false) {
              deniedCategories.push(cat);
            }
          }
        }
      } catch {
        // If we can't fetch the record, mark all read categories as denied.
        deniedCategories = [...READ_PREFERENCES];
      }

      // Also check profile labels for explicit opt-out signals.
      const labelResult = await checkProfileOptOut(agent, did);
      if (labelResult.hasLabelOptOut) {
        for (const cat of labelResult.deniedCategories) {
          if (!deniedCategories.includes(cat)) {
            deniedCategories.push(cat);
          }
        }
      }

      optOutDids.push(did);
    }

    // Build participant record.
    const post = findPostInThread(threadView, did);
    participants.push({
      did,
      handle: post?.author?.handle ?? 'unknown',
      displayName: post?.author?.displayName,
      aiPrefDenied: allowed === false || deniedCategories.length > 0,
      deniedCategories,
    });
  }

  const hasOptOuts = optOutDids.length > 0;

  return {
    threadView,
    permissionSummary: { participants, hasOptOuts, optOutDids },
    canReplyWithAi: !hasOptOuts, // safe to reply with AI only if no one opted out
  };
}

/**
 * Find a post by DID anywhere in the recursive thread view.
 */
function findPostInThread(threadView: any, did: string): any {
  if (!threadView || typeof threadView !== 'object') return null;

  const post = (threadView as any).post;
  if (post?.author?.did === did) return post;

  // Check parent chain.
  const parent = (threadView as any).parent;
  if (parent) {
    const found = findPostInThread(parent, did);
    if (found) return found;
  }

  // Check replies.
  const replies = (threadView as any).replies;
  if (Array.isArray(replies)) {
    for (const reply of replies) {
      const found = findPostInThread(reply, did);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Format a human-readable summary of the thread's permission status.
 */
export function formatPermissionSummary(summary: ThreadPermissionSummary): string {
  const lines: string[] = [];

  lines.push(`Thread participants: ${summary.participants.length}`);

  for (const p of summary.participants) {
    if (p.aiPrefDenied) {
      lines.push(
        `  - @${p.handle} (${p.did}) — OPT OUT [${p.deniedCategories.join(', ')}]`
      );
    } else {
      lines.push(`  - @${p.handle} (${p.did}) — OK`);
    }
  }

  if (summary.hasOptOuts) {
    lines.push(
      `\n\u26a0 AI reply generation is BLOCKED: ${summary.optOutDids.length} participant(s) have opted out of inference/training.`
    );
  } else {
    lines.push('\n\u2713 All participants allow AI inference/training.');
  }

  return lines.join('\n');
}

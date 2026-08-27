/**
 * AI Preferences module — reads/writes community.lexicon.preference.ai records
 * and provides a cached, batch-friendly API for checking whether a given DID's
 * content may be fetched under the current user's preferences.
 */

import { AtpAgent } from '@atproto/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single category entry inside preferences (actual API format) */
interface AiPrefCategoryRaw {
  allow: boolean;
  updatedAt?: string;
}

/** Shape of community.lexicon.preference.ai record as returned by the API */
export interface AiPreferencesRecordRaw {
  scope?: unknown;
  updatedAt?: string;
  preferences?: {
    training?: AiPrefCategoryRaw;
    inference?: AiPrefCategoryRaw;
    syntheticContent?: AiPrefCategoryRaw;
    embedding?: AiPrefCategoryRaw;
  };
}

/** Flat allow/deny representation used internally */
export interface AiPreferencesRecord {
  training?: 'allow' | 'deny';
  inference?: 'allow' | 'deny';
  syntheticContent?: 'allow' | 'deny';
  embedding?: 'allow' | 'deny';
}

/** Convert a nested boolean allow to 'allow' | 'deny' */
function boolToAllowDeny(allow: boolean | undefined): 'allow' | 'deny' {
  return allow !== false ? 'allow' : 'deny';
}

/** Extract the flat allow/deny record from the nested API response. */
export function flattenAiPreferences(record: AiPreferencesRecordRaw): AiPreferencesRecord {
  const p = record.preferences ?? {};
  return {
    training: boolToAllowDeny(p.training?.allow),
    inference: boolToAllowDeny(p.inference?.allow),
    syntheticContent: boolToAllowDeny(p.syntheticContent?.allow),
    embedding: boolToAllowDeny(p.embedding?.allow),
  };
}

/** Convert a flat allow/deny record back to the nested API format. */
export function unflattenAiPreferences(flat: AiPreferencesRecord): {
  training?: AiPrefCategoryRaw;
  inference?: AiPrefCategoryRaw;
  syntheticContent?: AiPrefCategoryRaw;
  embedding?: AiPrefCategoryRaw;
} {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (value) {
      result[key] = { allow: value === 'allow' };
    }
  }
  return result as typeof result;
}

/** Which categories the current user cares about for *reading* content. */
export type ReadPreference = 'inference' | 'training' | 'syntheticContent' | 'embedding';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI_PREFS_COLLECTION = 'community.lexicon.preference.ai';
const AI_PREFS_RKEY = 'self';

/** Categories that control whether we may *read* content from a user. */
export const READ_PREFERENCES: ReadPreference[] = ['inference', 'training'];

// ---------------------------------------------------------------------------
// Cache (per-server-instance)
// ---------------------------------------------------------------------------

interface PrefCacheEntry {
  record: AiPreferencesRecord;
  expiresAt: number; // ms since epoch
}

const PREF_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, PrefCacheEntry>();

/**
 * Check whether a DID's content may be read under the given preferences.
 * Returns true if the user has not set any deny for the relevant categories
 * (i.e., unset is treated as "allow").
 */
export function isContentAllowed(
  did: string,
  prefs: ReadPreference[] = READ_PREFERENCES
): boolean {
  const entry = cache.get(did);
  if (!entry || Date.now() > entry.expiresAt) return false; // miss — will fetch

  const record = entry.record;
  for (const cat of prefs) {
    if (record[cat] === 'deny') return false;
  }
  return true;
}

/**
 * Fetch a DID's AI preferences from their repo and cache the result.
 */
export async function fetchAiPreferences(
  agent: AtpAgent,
  did: string
): Promise<AiPreferencesRecord | null> {
  try {
    const response = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: AI_PREFS_COLLECTION,
      rkey: AI_PREFS_RKEY,
    });

    if (!response.success) return null;

    // The API returns a nested structure; flatten it to our internal format.
    const raw = response.data as AiPreferencesRecordRaw;
    const record = flattenAiPreferences(raw);

    // Cache the result
    cache.set(did, {
      record,
      expiresAt: Date.now() + PREF_CACHE_TTL_MS,
    });

    return record;
  } catch {
    return null;
  }
}

/**
 * Check a single DID's preferences (fetches if not cached) and returns whether
 * content from that user may be read.
 */
export async function checkAiPreference(
  agent: AtpAgent,
  did: string,
  prefs: ReadPreference[] = READ_PREFERENCES
): Promise<boolean> {
  // Check cache first
  const entry = cache.get(did);
  if (entry && Date.now() <= entry.expiresAt) {
    for (const cat of prefs) {
      if (entry.record[cat] === 'deny') return false;
    }
    return true;
  }

  // Fetch and cache
  const record = await fetchAiPreferences(agent, did);
  if (!record) return true; // no record found — treat as allow (unset)

  for (const cat of prefs) {
    if (record[cat] === 'deny') return false;
  }
  return true;
}

/**
 * Batch-check a list of DIDs. Fetches uncached entries in parallel and returns
 * a map from DID → allowed boolean.
 */
export async function batchCheckAiPreferences(
  agent: AtpAgent,
  dids: string[],
  prefs: ReadPreference[] = READ_PREFERENCES
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  // Separate cached vs uncached DIDs
  const uncachedDids: string[] = [];
  for (const did of dids) {
    const entry = cache.get(did);
    if (entry && Date.now() <= entry.expiresAt) {
      let allowed = true;
      for (const cat of prefs) {
        if (entry.record[cat] === 'deny') {
          allowed = false;
          break;
        }
      }
      results.set(did, allowed);
    } else {
      uncachedDids.push(did);
    }
  }

  // Fetch uncached DIDs in parallel (cap at 20 concurrent to avoid flooding)
  const BATCH_SIZE = 20;
  for (let i = 0; i < uncachedDids.length; i += BATCH_SIZE) {
    const batch = uncachedDids.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (did) => {
        const record = await fetchAiPreferences(agent, did);
        let allowed = true;
        if (record) {
          for (const cat of prefs) {
            if (record[cat] === 'deny') {
              allowed = false;
              break;
            }
          }
        }
        results.set(did, allowed);
      })
    );
  }

  return results;
}

/**
 * Filter an array of FeedViewPost-like items by AI preferences.
 * Returns { filtered: [...], skippedCount: number }.
 */
export function filterPostsByAiPreferences(
  posts: any[],
  allowedDids: Map<string, boolean>
): { filtered: any[]; skippedCount: number } {
  let skipped = 0;
  const filtered = posts.filter((item) => {
    const post = item?.post;
    if (!post || !post.author?.did) return true; // keep items without author info

    const allowed = allowedDids.get(post.author.did);
    if (allowed === false) {
      skipped++;
      return false;
    }
    return true; // undefined means not cached yet — allow (will be fetched next time)
  });

  return { filtered, skippedCount: skipped };
}

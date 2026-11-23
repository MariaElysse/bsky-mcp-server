/**
 * AI Preferences module — reads/writes community.lexicon.preference.ai records
 * and provides a cached, batch-friendly API for checking whether a given DID's
 * content may be fetched under the current user's preferences.
 *
 * Lookups are memoized per DID for PREF_CACHE_TTL_MS — hits *and* negative
 * results ("no record" / "lookup failed") — and the cache is bounded to
 * MAX_PREF_CACHE_ENTRIES entries with least-recently-used eviction.
 */

import { Agent } from '@atproto/api';

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

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow the untyped `value` from `com.atproto.repo.getRecord` to the
 * community.lexicon.preference.ai shape. The lexicon is not part of the
 * generated client, so `value` is only `Record<string, unknown>` there.
 *
 * Anything that does not match — a scalar, an array, a `preferences` block
 * whose category entries are not `{ allow: boolean }` objects — fails the
 * guard, and callers treat a failed guard as "no record", so a malformed
 * record never throws and never denies content.
 */
function isAiPreferencesRecordRaw(value: unknown): value is AiPreferencesRecordRaw {
  if (!isPlainObject(value)) return false;

  const preferences = value.preferences;
  if (preferences === undefined || preferences === null) return true;
  if (!isPlainObject(preferences)) return false;

  for (const category of PREFERENCE_CATEGORIES) {
    const entry = preferences[category];
    if (entry === undefined || entry === null) continue;
    if (!isPlainObject(entry)) return false;
    if (entry.allow !== undefined && typeof entry.allow !== 'boolean') return false;
  }
  return true;
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

/**
 * The outcome of checking one DID, together with the record it was derived
 * from, so callers never need a second lookup to populate tombstone metadata.
 */
export interface AiPreferenceCheck {
  /** False only when the author's record denies one of the checked categories. */
  allowed: boolean;
  /** The author's flattened record, or null when they have no readable record. */
  record: AiPreferencesRecord | null;
  /** Which of the checked categories were denied — empty whenever `allowed` is true. */
  deniedCategories: ReadPreference[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI_PREFS_COLLECTION = 'community.lexicon.preference.ai';
const AI_PREFS_RKEY = 'self';

/** Every category the community.lexicon.preference.ai lexicon defines. */
const PREFERENCE_CATEGORIES: ReadPreference[] = [
  'training',
  'inference',
  'syntheticContent',
  'embedding',
];

/** Categories that control whether we may *read* content from a user. */
export const READ_PREFERENCES: ReadPreference[] = ['inference', 'training'];

// ---------------------------------------------------------------------------
// Cache (per-server-instance)
// ---------------------------------------------------------------------------

/** How a cached lookup resolved: a record, or one of two negative results. */
type PrefCacheStatus = 'record' | 'no-record' | 'lookup-failed';

interface PrefCacheEntry {
  status: PrefCacheStatus;
  /** Flattened record, or null whenever `status` is negative. */
  record: AiPreferencesRecord | null;
  expiresAt: number; // ms since epoch
}

const PREF_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PREF_CACHE_ENTRIES = 5000;

/**
 * Per-DID preference lookups. Bounded to MAX_PREF_CACHE_ENTRIES with
 * least-recently-used eviction: reads refresh an entry's recency, expired
 * entries are dropped when touched, and inserting past the cap evicts the
 * least recently used entries. Both hits and negative results ("no record" /
 * "lookup failed") are cached for PREF_CACHE_TTL_MS, so a feed page full of
 * authors without records costs one lookup per author, not one per post.
 */
const cache = new Map<string, PrefCacheEntry>();

/** Build a cache entry that expires after PREF_CACHE_TTL_MS. */
function prefCacheEntry(status: PrefCacheStatus, record: AiPreferencesRecord | null): PrefCacheEntry {
  return { status, record, expiresAt: Date.now() + PREF_CACHE_TTL_MS };
}

/** Return a live cache entry, dropping it if expired and refreshing its recency. */
function readCacheEntry(did: string): PrefCacheEntry | null {
  const entry = cache.get(did);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(did);
    return null;
  }

  // Map iteration order is insertion order, so re-inserting the entry marks
  // it as the most recently used.
  cache.delete(did);
  cache.set(did, entry);
  return entry;
}

/** Insert or refresh an entry, evicting least recently used entries past the cap. */
function writeCacheEntry(did: string, entry: PrefCacheEntry): void {
  cache.delete(did);
  cache.set(did, entry);

  while (cache.size > MAX_PREF_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Drop every cached preference — positive records and negative results alike.
 * Tests use this to isolate cache behaviour; a re-login should call it too,
 * because a reconnected session may resolve different records.
 */
export function clearPreferenceCache(): void {
  cache.clear();
}

/** Derive the verdict, record, and denied categories for a record (or its absence). */
function evaluatePreferenceRecord(
  record: AiPreferencesRecord | null,
  prefs: ReadPreference[]
): AiPreferenceCheck {
  const deniedCategories: ReadPreference[] = [];
  if (record) {
    for (const cat of prefs) {
      if (record[cat] === 'deny') deniedCategories.push(cat);
    }
  }
  return { allowed: deniedCategories.length === 0, record, deniedCategories };
}

/**
 * Fetch a DID's AI preferences from their repo and memoize the result.
 *
 * A live cache entry — positive *or* negative — is returned without a lookup;
 * clearPreferenceCache() forces a fresh one. A malformed record counts as
 * "no record". Every negative result means `null`, which callers treat as
 * "allowed": an unknown DID is never silently denied.
 */
export async function fetchAiPreferences(
  agent: Agent,
  did: string
): Promise<AiPreferencesRecord | null> {
  const cached = readCacheEntry(did);
  if (cached) return cached.record;

  return lookupAndCachePreferences(agent, did);
}

/** Unconditional lookup that writes the positive or negative cache entry. */
async function lookupAndCachePreferences(
  agent: Agent,
  did: string
): Promise<AiPreferencesRecord | null> {
  try {
    // getRecord is on the unauthenticated base Agent — no AtpAgent session is
    // needed to read another repo's preferences.
    const response = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: AI_PREFS_COLLECTION,
      rkey: AI_PREFS_RKEY,
    });

    if (!response.success) {
      writeCacheEntry(did, prefCacheEntry('lookup-failed', null));
      return null;
    }

    // @atproto/api getRecord returns { uri, cid, value: {...} } and the
    // community.lexicon.preference.ai lexicon is not in the generated client,
    // so narrow the untyped value instead of casting it.
    const data: unknown = response.data;
    const value = isPlainObject(data) ? data.value : undefined;
    if (!isAiPreferencesRecordRaw(value)) {
      writeCacheEntry(did, prefCacheEntry('no-record', null));
      return null;
    }

    const record = flattenAiPreferences(value);
    writeCacheEntry(did, prefCacheEntry('record', record));
    return record;
  } catch {
    // A PDS that is unreachable or rejects the lookup must not deny content.
    writeCacheEntry(did, prefCacheEntry('lookup-failed', null));
    return null;
  }
}

/**
 * Check a single DID's preferences (fetches if not cached) and returns whether
 * content from that user may be read. Missing records and failed lookups allow.
 */
export async function checkAiPreference(
  agent: Agent,
  did: string,
  prefs: ReadPreference[] = READ_PREFERENCES
): Promise<boolean> {
  const record = await fetchAiPreferences(agent, did);
  return evaluatePreferenceRecord(record, prefs).allowed;
}

/**
 * Batch-check a list of DIDs, returning the verdict, the author's record, and
 * the categories that caused a denial for each one — in a single pass, so a
 * caller never needs a follow-up fetch to populate tombstone metadata.
 * Duplicate DIDs collapse to one entry, each uncached DID is looked up at most
 * once, and negative results are cached like records.
 */
export async function batchCheckAiPreferenceRecords(
  agent: Agent,
  dids: string[],
  prefs: ReadPreference[] = READ_PREFERENCES
): Promise<Map<string, AiPreferenceCheck>> {
  const results = new Map<string, AiPreferenceCheck>();

  // Separate cached vs uncached DIDs (duplicates collapse to one lookup)
  const uncachedDids: string[] = [];
  const seen = new Set<string>();
  for (const did of dids) {
    if (seen.has(did)) continue;
    seen.add(did);

    const entry = readCacheEntry(did);
    if (entry) {
      results.set(did, evaluatePreferenceRecord(entry.record, prefs));
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
        const record = await lookupAndCachePreferences(agent, did);
        results.set(did, evaluatePreferenceRecord(record, prefs));
      })
    );
  }

  return results;
}

/**
 * Batch-check a list of DIDs and return a map from DID → allowed boolean.
 * Thin wrapper over batchCheckAiPreferenceRecords for callers that only need
 * the verdict; use that API directly when the record or denied categories are
 * also needed, so the second pass disappears.
 */
export async function batchCheckAiPreferences(
  agent: Agent,
  dids: string[],
  prefs: ReadPreference[] = READ_PREFERENCES
): Promise<Map<string, boolean>> {
  const checks = await batchCheckAiPreferenceRecords(agent, dids, prefs);

  const results = new Map<string, boolean>();
  for (const [did, check] of checks) {
    results.set(did, check.allowed);
  }
  return results;
}

/**
 * Shape of a tombstone placeholder inserted when a post is excluded by AI preferences.
 * Preserves the item's position in the array so thread/feed ordering stays consistent.
 */
export interface AiPreferenceTombstone {
  /** Always false — marks this as an excluded post */
  __aiPrefExcluded: true;
  /** The original FeedViewPost-like item (preserved for metadata) */
  originalItem: any;
  /** Which preference categories caused the denial */
  deniedCategories?: string[];
}

/**
 * Filter an array of FeedViewPost-like items by AI preferences.
 * Excluded posts are replaced with tombstone placeholders so that feed order,
 * thread hierarchy, and item count remain consistent — the post is not silently dropped.
 * Returns { filtered: [...], skippedCount: number }.
 *
 * @param posts - Array of FeedViewPost-like items to filter.
 * @param allowedDids - Map from DID → true (allowed) or false (denied).
 * @param deniedRecords - Optional map from DID → full AiPreferencesRecord. When provided,
 *   tombstones include the specific categories that caused denial in `deniedCategories`.
 */
export function filterPostsByAiPreferences(
  posts: any[],
  allowedDids: Map<string, boolean>,
  deniedRecords?: Map<string, AiPreferencesRecord>
): { filtered: any[]; skippedCount: number } {
  let skipped = 0;
  const filtered = posts.map((item) => {
    const post = item?.post;
    if (!post || !post.author?.did) return item; // keep items without author info

    const allowed = allowedDids.get(post.author.did);
    if (allowed === false) {
      skipped++;
      // Populate deniedCategories from the full record when available
      let categories: string[] | undefined;
      if (deniedRecords?.has(post.author.did)) {
        const record = deniedRecords.get(post.author.did)!;
        for (const cat of READ_PREFERENCES) {
          if (record[cat] === 'deny') {
            categories ??= [];
            categories.push(cat);
          }
        }
      }
      return {
        __aiPrefExcluded: true,
        originalItem: item,
        deniedCategories: categories,
      } as AiPreferenceTombstone;
    }
    return item; // DID not in allowedDids map: either never batch-checked or cache-missed.
    // Treated as "allow" for privacy-first fallback (never block content on missing data).
  });

  return { filtered, skippedCount: skipped };
}

// Re-export thread-related helpers from llm-preprocessor for test compatibility.
// These are logically part of the AI preferences system (thread filtering).
export function getDidsFromThread(threadView: any): string[] {
  if (!threadView || typeof threadView !== 'object') return [];
  const dids: string[] = [];
  const post = threadView.post;
  if (post?.author?.did) dids.push(post.author.did);
  if (threadView.parent) {
    dids.push(...getDidsFromThread(threadView.parent));
  }
  if (threadView.replies && Array.isArray(threadView.replies)) {
    for (const reply of threadView.replies) {
      dids.push(...getDidsFromThread(reply));
    }
  }
  return dids;
}

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
    // Still recursively filter its parent and replies
    if (threadView.parent) {
      const filteredParent = filterThreadByAiPreferences(threadView.parent, allowedDids, false);
      threadView.parent = filteredParent || undefined;
    }
    if (threadView.replies && Array.isArray(threadView.replies)) {
      threadView.replies = threadView.replies.map((r: any) =>
        filterThreadByAiPreferences(r, allowedDids, false)
      );
      // Filter out null entries (removed denied posts)
      threadView.replies = threadView.replies.filter((r: any) => r !== null);
    }
    return threadView;
  }

  // Check if this post's author is denied
  const did = post.author?.did;
  if (did && allowedDids.get(did) === false) {
    return null; // Remove denied posts from threads
  }

  // Allowed — recursively filter parent and replies
  if (threadView.parent) {
    const filteredParent = filterThreadByAiPreferences(threadView.parent, allowedDids, false);
    threadView.parent = filteredParent || undefined;
  }
  if (threadView.replies && Array.isArray(threadView.replies)) {
    threadView.replies = threadView.replies.map((r: any) =>
      filterThreadByAiPreferences(r, allowedDids, false)
    );
    // Filter out null entries (removed denied posts)
    threadView.replies = threadView.replies.filter((r: any) => r !== null);
  }

  return threadView;
}

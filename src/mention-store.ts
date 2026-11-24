/**
 * Persistent JSON-file-based store for tracking Bluesky mentions to prevent
 * duplicate replies.  Uses atomic writes (write-to-temp-then-rename) and a
 * lock mechanism so concurrent processes don't corrupt the data: the lock file
 * records an owner token (`pid:random`), and a lock is only stolen from a
 * holder that is provably gone — a pid that no longer exists, or a lock file
 * untouched for {@link LOCK_STALE_MS}.
 *
 * Entries age out through the per-status windows in {@link DEFAULT_RETENTION}.
 * The long-lived stdio process runs that pass lazily — once when the singleton
 * store is created, then at most once an hour per store path from the write
 * path — so no timer is registered that would keep the process alive at exit.
 */

import { promises as fs, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status of a single mention entry in the store.
 *
 * Terminal vs. re-considerable:
 * - `pending`  — queued or mid-flight; not terminal, `isHandled()` is false.
 * - `replied`  — a reply was posted; terminal, `isHandled()` is true.
 * - `failed`   — processing errored; terminal by design (so a broken path isn't
 *                retried forever), `isHandled()` is true.
 * - `skipped`  — deliberately not processed under the rules in effect at that
 *                moment (e.g. the author's AI preference denied inference). Not a
 *                reply and not a failure, so **not** terminal: `isHandled()` is
 *                false and a later preference change lets the mention be retried.
 */
export type MentionStatus = "pending" | "replied" | "failed" | "skipped";

/** A single record stored on disk. */
export interface MentionEntry {
  /** Unique identifier (usually the Bluesky AT URI). */
  id: string;
  /** The Bluesky AT URI of the mentioning post. */
  uri: string;
  /** Current processing status. */
  status: MentionStatus;
  /** Unix timestamp in milliseconds when this entry was created/updated. */
  timestamp: number;
  /** Optional URI of the reply that was posted (set on markCompleted). */
  replyUri?: string;
  /** Optional error message (set on markFailed; failure-only, never used for skips). */
  error?: string;
  /**
   * Optional human-readable reason the mention was skipped (set on markSkipped).
   * Kept separate from `error` so a skip stays observable — when and why it
   * happened — without pretending the attempt failed.
   */
  reason?: string;
}

/**
 * Retention window per status, in milliseconds since the entry's last status
 * change. A window of `Infinity` keeps matching entries forever.
 */
export type RetentionPolicy = Record<MentionStatus, number>;

/**
 * Decide whether a stored status means "this mention is done, never process it
 * again" — i.e. `replied` or `failed`. `pending` and `skipped` are the two
 * non-terminal statuses: a skip is a policy decision made under the rules that
 * applied at the time (author opt-out), so it must stay re-considerable when
 * those rules change.
 *
 * Takes `string` rather than {@link MentionStatus} because it is applied to
 * unvalidated JSON already on disk. A status value outside the union (legacy or
 * hand-edited file) counts as terminal on purpose: the store exists to prevent
 * duplicate replies, so an unrecognised value is treated as already processed
 * rather than replayed.
 */
function isTerminalStatus(status: string): boolean {
  return status !== "pending" && status !== "skipped";
}

/** Shape of the JSON file on disk. */
interface StoreFile {
  version: number;
  entries: MentionEntry[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STORE_VERSION = 1;
const DEFAULT_STORE_PATH = ".mention-store.json";
const LOCK_FILE_SUFFIX = ".lock";
const MAX_WRITE_ATTEMPTS = 50;
const WRITE_RETRY_MS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A lock file is only taken over when its holder is demonstrably gone: either
 * the pid recorded in it no longer exists on this host, or the file has not
 * been touched for at least this long.
 *
 * The acquire loop itself waits at most MAX_WRITE_ATTEMPTS × WRITE_RETRY_MS
 * (50 × 20 ms = 1 s), so 30 s is 30× that budget. A live holder that is merely
 * slow, contended, or parked mid-retry therefore keeps its lock — stealing it
 * would lose that process's updates — while a process that crashed without
 * releasing stops blocking the store within half a minute.
 */
export const LOCK_STALE_MS = 30 * 1000;

/** Minimum gap between lazily triggered retention passes, per store path. */
const RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long each status is kept after its last update.
 *
 * - `replied` — 30 days, the longest window by design: a replied entry *is* the
 *   duplicate-reply guard (`isHandled()` is true for it), so ageing it out early
 *   re-exposes that mention to being answered a second time.
 * - `failed` — 7 days: the terminal marker that stops a broken path from being
 *   retried on every poll. After a week it is history; if the mention is still
 *   around it deserves another look.
 * - `pending` — 7 days: still pending after a week means an interrupted run,
 *   not a live one.
 * - `skipped` — 24 hours: skips are non-terminal (the mention is re-visited
 *   when the governing preference flips), so the entry is only a short-lived
 *   record of why it was passed over today.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  replied: 30 * DAY_MS,
  failed: 7 * DAY_MS,
  pending: 7 * DAY_MS,
  skipped: DAY_MS,
};

/**
 * Write a one-line operational note to stderr — the log channel for a stdio MCP
 * server, since stdout carries the protocol. This module deliberately does not
 * import `utils.mcpLog`: it is a leaf module the test suites load on their own,
 * and `mcpLog` is gated behind LOG_RESPONSES, which would hide a lock takeover
 * or a failed retention pass. Never throws: reporting must not be the thing
 * that breaks a mention write.
 */
function storeNote(message: string): void {
  try {
    console.error(`[mention-store] ${message}`);
  } catch {
    /* ignore */
  }
}

/** Resolve the store file path from env or default. */
function resolveStorePath(): string {
  const raw = process.env.MENTION_STORE_PATH;
  if (raw && raw.trim() !== "") return path.resolve(raw.trim());
  return path.resolve(DEFAULT_STORE_PATH);
}

function lockFilePath(storePath: string): string {
  return storePath + LOCK_FILE_SUFFIX;
}

// In-process queue per storePath to guarantee strict serialization within the same process
const processLocks = new Map<string, Promise<void>>();

async function acquireProcessLock(storePath: string): Promise<() => void> {
  const currentLock = processLocks.get(storePath) ?? Promise.resolve();
  let resolveNext: () => void;
  const nextLock = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  processLocks.set(storePath, nextLock);

  await currentLock;
  return () => {
    resolveNext!();
    if (processLocks.get(storePath) === nextLock) {
      processLocks.delete(storePath);
    }
  };
}

// ---------------------------------------------------------------------------
// File-level locking (cross-process safe via exclusive file creation)
// ---------------------------------------------------------------------------

/** An acquired lock: where it lives, plus the token that proves we own it. */
interface LockHandle {
  lockPath: string;
  /** Written into the lock file on acquire; re-checked before unlinking. */
  token: string;
  releaseProcess: () => void;
}

/**
 * Owner token for a lock file: this process's pid plus a random suffix. The pid
 * lets a later acquirer probe liveness; the suffix distinguishes two locks held
 * by the same pid, or by a pid that was recycled after its original owner died.
 */
function createLockToken(): string {
  return `${process.pid}:${randomBytes(8).toString("hex")}`;
}

/**
 * Read the current owner token from a lock file, or null if it is absent or
 * unreadable. Null means "we cannot tell who owns this", which never justifies
 * taking the lock over.
 */
async function readLockToken(lockPath: string): Promise<string | null> {
  try {
    return (await fs.readFile(lockPath, "utf-8")).trim();
  } catch {
    return null;
  }
}

/**
 * Extract the pid recorded in a lock token — `pid:suffix` for locks written by
 * this version, or a bare pid left behind by an older build.
 */
function parseLockPid(token: string | null): number | undefined {
  if (!token) return undefined;
  const pid = Number(token.split(":")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Is this pid demonstrably not running on this host?
 *
 * `process.kill(pid, 0)` sends no signal, it only probes: success means the
 * process is alive, EPERM means it exists but belongs to someone else (so it is
 * alive too), and only ESRCH proves it is gone. Our own pid is alive by
 * definition.
 */
function isPidProvablyDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "ESRCH";
  }
}

/**
 * Decide whether an existing lock file may be treated as abandoned. Returns a
 * human-readable reason when it is safe to take over — the recorded holder is
 * provably dead, or the file has not been touched for {@link LOCK_STALE_MS} —
 * and null when the holder still looks live, in which case the lock has to be
 * waited for rather than stolen.
 */
async function explainStaleLock(lockPath: string): Promise<string | null> {
  let stat: Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return null; // gone, or unreadable: the caller should just retry the create
  }

  const pid = parseLockPid(await readLockToken(lockPath));
  if (pid !== undefined && isPidProvablyDead(pid)) {
    return `holder pid ${pid} no longer exists on this host`;
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs >= LOCK_STALE_MS) {
    return `lock file is ${Math.round(ageMs / 1000)}s old, at least LOCK_STALE_MS (${LOCK_STALE_MS / 1000}s)`;
  }
  return null;
}

/**
 * Claim a lock file that was judged abandoned. The overwrite is deliberately
 * followed by an ownership re-check: two processes can reach the same stale
 * verdict, and whichever one no longer finds its own token in the file lost
 * that race, so it keeps waiting instead of writing over the winner.
 */
async function takeOverLock(lockPath: string, token: string, reason: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, token, { flag: "w" });
  } catch {
    return false;
  }
  if ((await readLockToken(lockPath)) !== token) return false;
  storeNote(`took over abandoned mention-store lock ${lockPath}: ${reason}`);
  return true;
}

/**
 * Acquire an exclusive write lock by creating a lock file that records this
 * process's owner token. Returns the lock handle so {@link releaseLock} can
 * prove the lock is still ours before unlinking it.
 *
 * Contention is retried MAX_WRITE_ATTEMPTS times, but the staleness of the
 * current holder is checked on every attempt: a holder that crashed stops
 * blocking the store almost immediately instead of after the whole retry
 * budget. When the budget runs out on a lock that is neither provably dead nor
 * old enough, this throws rather than stealing it — silently overwriting a live
 * holder's lock is how the store loses updates.
 */
async function acquireLock(storePath: string): Promise<LockHandle> {
  const releaseProcess = await acquireProcessLock(storePath);
  const lf = lockFilePath(storePath);
  const token = createLockToken();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      await fs.writeFile(lf, token, { flag: "wx" });
      return { lockPath: lf, token, releaseProcess };
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code !== "EEXIST") {
        releaseProcess();
        throw err;
      }
      const stale = await explainStaleLock(lf);
      if (stale && (await takeOverLock(lf, token, stale))) {
        return { lockPath: lf, token, releaseProcess };
      }
      await sleep(WRITE_RETRY_MS);
    }
  }

  // Retry budget exhausted. The only exits from here are a lock that has become
  // demonstrably abandoned, and an error that leaves the store untouched.
  const stale = await explainStaleLock(lf);
  if (stale && (await takeOverLock(lf, token, stale))) {
    return { lockPath: lf, token, releaseProcess };
  }

  releaseProcess();
  const holder = await readLockToken(lf);
  throw new Error(
    `Mention-store lock ${lf} is still held${holder ? ` by ${holder}` : ""} after ` +
      `${MAX_WRITE_ATTEMPTS} attempts (${MAX_WRITE_ATTEMPTS * WRITE_RETRY_MS}ms): its holder is neither ` +
      `provably dead nor older than LOCK_STALE_MS (${LOCK_STALE_MS}ms), so the lock was not taken over ` +
      "and the mention store was not written."
  );
}

/**
 * Release a previously acquired lock — but only while the lock file still
 * contains our token. If another writer took it over while we were busy,
 * unlinking it would admit a third writer on top of them.
 */
async function releaseLock(lockInfo: LockHandle): Promise<void> {
  try {
    const current = await fs.readFile(lockInfo.lockPath, "utf-8");
    if (current.trim() === lockInfo.token) {
      await fs.unlink(lockInfo.lockPath);
    }
  } catch {
    /* already gone, or unreadable and therefore not provably ours — nothing safe to unlink */
  } finally {
    lockInfo.releaseProcess();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/** Read the store file; returns an empty store if it doesn't exist yet. */
async function readStore(storePath: string): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    return JSON.parse(raw) as StoreFile;
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") {
      return { version: STORE_VERSION, entries: [] };
    }
    throw err;
  }
}

/** Atomically write the store to disk. */
async function writeStore(storePath: string, data: StoreFile): Promise<void> {
  const tmp = storePath + ".tmp." + process.pid;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmp, storePath);
  } catch (err) {
    // Clean up temp file on failure.
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Retention (aging entries out)
// ---------------------------------------------------------------------------

/**
 * Retention window for a status. A status outside {@link MentionStatus} — a
 * legacy or hand-edited file — falls back to the longest window in the policy,
 * so pruning can never throw away state whose meaning we do not understand: for
 * a `replied`-like value that would mean re-allowing a duplicate reply. The
 * lookup is an own-property check, so an inherited key (`constructor`,
 * `toString`) can never masquerade as a window.
 */
function windowForStatus(policy: RetentionPolicy, status: string): number {
  return Object.prototype.hasOwnProperty.call(policy, status)
    ? policy[status as MentionStatus]
    : Math.max(...Object.values(policy));
}

/**
 * Drop entries whose age (`now - timestamp`) has reached the window configured
 * for their status, in place, and report how many were dropped.
 */
function applyRetention(store: StoreFile, policy: RetentionPolicy, now: number): number {
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => now - e.timestamp < windowForStatus(policy, e.status));
  return before - store.entries.length;
}

/** One uniform window for every status — what `cleanup(maxAgeMs)` means. */
function uniformPolicy(maxAgeMs: number): RetentionPolicy {
  return { replied: maxAgeMs, failed: maxAgeMs, pending: maxAgeMs, skipped: maxAgeMs };
}

/**
 * Read-modify-write the store under the lock, letting `drop` decide which
 * entries age out. The file is only rewritten when something actually changed.
 */
async function pruneStore(storePath: string, drop: (store: StoreFile, now: number) => number): Promise<number> {
  const lf = await acquireLock(storePath);
  try {
    const store = await readStore(storePath);
    const removed = drop(store, Date.now());
    if (removed > 0) {
      await writeStore(storePath, store);
    }
    return removed;
  } finally {
    await releaseLock(lf);
  }
}

/**
 * When each store path last ran a lazy retention pass, so the pass happens at
 * most once per RETENTION_PRUNE_INTERVAL_MS per path across every instance in
 * this process (`tools.ts` builds throwaway instances against the same path).
 * Bounded by the number of store paths a process ever touches.
 */
const lastRetentionPruneAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// Public API — class-based store
// ---------------------------------------------------------------------------

/**
 * Create a mention store instance backed by the configured JSON file.
 * The path is resolved once at construction time so multiple instances
 * in the same process can share state via the same file.
 *
 * Retention — an entry is dropped once its age since the last status change
 * reaches the window configured for its status (see {@link DEFAULT_RETENTION}
 * and {@link pruneByRetention}):
 *
 * | status    | window   | why                                                                   |
 * |-----------|----------|-----------------------------------------------------------------------|
 * | `replied` | 30 days  | the duplicate-reply guard — `isHandled()` is true for it, so dropping  |
 * |           |          | it early is what lets the same mention get answered twice. It outlives |
 * |           |          | every other status for exactly that reason.                            |
 * | `failed`  | 7 days   | terminal marker that stops a broken path being retried every poll;     |
 * |           |          | after a week it is history and the mention may be retried.             |
 * | `pending` | 7 days   | still pending after a week means an interrupted run, not a live one.  |
 * | `skipped` | 24 hours | non-terminal record of a policy skip; the mention is re-visited when   |
 * |           |          | the governing preference changes, so the entry is only today's reason. |
 *
 * The long-lived stdio process runs that pass through {@link getMentionStore}:
 * once when the store is created, then at most once an hour per store path from
 * the write path — no timer is registered, so nothing keeps the process alive at
 * exit. {@link cleanup} applies one flat window to every status and is **not**
 * what the live process uses: its 24 h default would delete `replied` entries
 * and cause duplicate replies.
 */
export class MentionStore {
  private readonly storePath: string;

  /**
   * Retention pass kicked off by {@link getMentionStore} when the store is
   * created. Resolved for instances built directly (tests, per-call instances);
   * the first write on an instance awaits it, so the startup pass is ordered
   * ahead of normal traffic instead of racing it.
   */
  private startupPrune: Promise<void> = Promise.resolve();

  constructor(storePath?: string) {
    this.storePath = storePath ?? resolveStorePath();
  }

  /**
   * @internal Start the retention pass for a newly created store.
   * {@link getMentionStore} calls this so a long-lived stdio process ages its
   * mention store without any `setInterval`. The returned promise never
   * rejects — a failed pass is reported, never propagated.
   */
  startRetentionPrune(): Promise<void> {
    this.startupPrune = this.pruneSafely();
    return this.startupPrune;
  }

  /**
   * Write-path hook: wait for any startup pass, then run a retention pass if
   * this store path has not had one within RETENTION_PRUNE_INTERVAL_MS. The
   * slot is claimed before the pass runs, so concurrent writers queue behind it
   * instead of stacking up redundant passes, and a failing pass is reported on
   * stderr rather than breaking the mention write it was supposed to follow.
   */
  private async retentionTick(): Promise<void> {
    await this.startupPrune;
    await this.pruneSafely();
  }

  private async pruneSafely(): Promise<void> {
    const now = Date.now();
    const last = lastRetentionPruneAt.get(this.storePath) ?? 0;
    if (now - last < RETENTION_PRUNE_INTERVAL_MS) return;
    lastRetentionPruneAt.set(this.storePath, now);
    try {
      const removed = await this.pruneByRetention();
      if (removed > 0) {
        storeNote(
          `retention pass removed ${removed} aged mention ${removed === 1 ? "entry" : "entries"} from ${this.storePath}`
        );
      }
    } catch (err: unknown) {
      storeNote(
        `retention pass skipped for ${this.storePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Check whether a mention is finished for good, i.e. whether its stored entry
   * carries a terminal status (`replied` or `failed`).
   *
   * Returns **false** when:
   * - no entry exists for the URI;
   * - the entry is `pending` (queued, or interrupted mid-flight);
   * - the entry is `skipped` — skipping records a decision made under the rules
   *   in effect at that moment (for example the author's AI preference denied
   *   inference). That is neither a reply nor an error, so the entry must not
   *   permanently suppress the mention: if the user later changes their
   *   preference, the mention has to be reconsidered. Use {@link markSkipped}
   *   (not {@link markFailed}) for conditions that can change.
   *
   * Returns **true** for `replied` (a reply already exists) and for `failed`
   * (the attempt errored and the store deliberately stops re-running a broken
   * path). A status value outside {@link MentionStatus} also counts as handled,
   * so a legacy or hand-edited file can never trigger a duplicate reply.
   */
  async isHandled(uri: string): Promise<boolean> {
    const store = await readStore(this.storePath);
    return store.entries.some(
      (e) => e.uri === uri && isTerminalStatus(e.status)
    );
  }

  /** Mark a URI as being handled (status set to pending). */
  async markInProgress(uri: string): Promise<void> {
    await this.retentionTick();
    const lf = await acquireLock(this.storePath);
    try {
      const store = await readStore(this.storePath);
      const idx = store.entries.findIndex((e) => e.uri === uri);
      if (idx !== -1) {
        // Prevent terminal-state regression: once replied/failed, never go back to pending.
        // `skipped` is intentionally NOT in this guard — re-opening a skipped mention is
        // exactly how a changed AI preference lets the mention be reconsidered.
        if (store.entries[idx].status === "replied" || store.entries[idx].status === "failed") {
          return;
        }
        store.entries[idx].status = "pending";
        store.entries[idx].timestamp = Date.now();
      } else {
        store.entries.push({
          id: uri,
          uri,
          status: "pending",
          timestamp: Date.now(),
        });
      }
      await writeStore(this.storePath, store);
    } finally {
      await releaseLock(lf);
    }
  }

  /** Mark a URI as successfully replied to. */
  async markCompleted(uri: string, replyUri?: string): Promise<void> {
    await this.retentionTick();
    const lf = await acquireLock(this.storePath);
    try {
      const store = await readStore(this.storePath);
      const idx = store.entries.findIndex((e) => e.uri === uri);
      if (idx !== -1) {
        store.entries[idx].status = "replied";
        store.entries[idx].replyUri = replyUri;
        store.entries[idx].timestamp = Date.now();
      } else {
        store.entries.push({
          id: uri,
          uri,
          status: "replied",
          timestamp: Date.now(),
          replyUri,
        });
      }
      await writeStore(this.storePath, store);
    } finally {
      await releaseLock(lf);
    }
  }

  /** Mark a URI as failed with an optional error message. */
  async markFailed(uri: string, error?: string): Promise<void> {
    await this.retentionTick();
    const lf = await acquireLock(this.storePath);
    try {
      const store = await readStore(this.storePath);
      const idx = store.entries.findIndex((e) => e.uri === uri);
      if (idx !== -1) {
        store.entries[idx].status = "failed";
        store.entries[idx].error = error;
        store.entries[idx].timestamp = Date.now();
      } else {
        store.entries.push({
          id: uri,
          uri,
          status: "failed",
          timestamp: Date.now(),
          error,
        });
      }
      await writeStore(this.storePath, store);
    } finally {
      await releaseLock(lf);
    }
  }

  /**
   * Mark a URI as deliberately skipped — a policy/opt-out decision (for example
   * the target author's AI preference denying inference), not a reply and not a
   * failure.
   *
   * Mirrors {@link markFailed}'s argument shape (`uri` plus one optional string)
   * so a call site can swap one for the other unchanged; the string is persisted
   * on the entry's `reason` field (never `error`), together with an updated
   * `timestamp`, so repeated skipping stays observable via {@link getAll}
   * instead of being silent.
   *
   * The resulting `skipped` status is **not** terminal: {@link isHandled} keeps
   * reporting false for the entry, so the mention is picked up again when the
   * governing preference changes, and {@link markInProgress} will move the entry
   * back to `pending`.
   *
   * Entries that are already terminal (`replied` or `failed`) are left untouched
   * — a skip must never un-do a reply that was actually posted, nor mask a real
   * error.
   *
   * @param uri - The Bluesky AT URI of the mentioning post.
   * @param reason - Optional human-readable explanation for the skip.
   */
  async markSkipped(uri: string, reason?: string): Promise<void> {
    await this.retentionTick();
    const lf = await acquireLock(this.storePath);
    try {
      const store = await readStore(this.storePath);
      const idx = store.entries.findIndex((e) => e.uri === uri);
      if (idx !== -1) {
        const entry = store.entries[idx];
        if (entry.status === "replied" || entry.status === "failed") {
          return;
        }
        entry.status = "skipped";
        entry.reason = reason;
        entry.timestamp = Date.now();
      } else {
        store.entries.push({
          id: uri,
          uri,
          status: "skipped",
          timestamp: Date.now(),
          reason,
        });
      }
      await writeStore(this.storePath, store);
    } finally {
      await releaseLock(lf);
    }
  }

  /** Get all mentions that are still pending (unhandled). */
  async getPending(): Promise<Array<{ uri: string; timestamp: number }>> {
    const store = await readStore(this.storePath);
    return store.entries
      .filter((e) => e.status === "pending")
      .map((e) => ({ uri: e.uri, timestamp: e.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp); // oldest first
  }

  /**
   * Remove entries that have outlived the retention window for their status and
   * return how many were dropped. `retention` overrides individual windows;
   * anything omitted keeps its {@link DEFAULT_RETENTION} value, and a window of
   * `Infinity` keeps that status forever.
   *
   * This is the aging pass the long-lived stdio process relies on, because it
   * keeps `replied` entries for 30 days: the entry is what stops the bot
   * answering the same mention twice. An entry is dropped once its age has
   * *reached* the window, i.e. `now - timestamp >= window`.
   */
  async pruneByRetention(retention?: Partial<RetentionPolicy>): Promise<number> {
    const policy: RetentionPolicy = { ...DEFAULT_RETENTION, ...retention };
    return pruneStore(this.storePath, (store, now) => applyRetention(store, policy, now));
  }

  /**
   * Remove entries older than maxAgeMs (default 24 hours), regardless of
   * status. Returns count removed.
   *
   * Explicit, blunt tooling — equivalent to {@link pruneByRetention} with one
   * flat window. The live process ages entries through
   * {@link pruneByRetention} instead, because a 24 h window would delete
   * `replied` entries and let old mentions be answered a second time.
   */
  async cleanup(maxAgeMs?: number): Promise<number> {
    const ageMs = maxAgeMs ?? DAY_MS;
    return pruneStore(this.storePath, (store, now) =>
      applyRetention(store, uniformPolicy(ageMs), now)
    );
  }

  /** Get the current number of entries in the store. */
  async size(): Promise<number> {
    const store = await readStore(this.storePath);
    return store.entries.length;
  }

  /**
   * Get all entries (useful for debugging and for status-aware reporting).
   * Each entry exposes its `status` — including non-terminal `skipped` — plus the
   * `reason` recorded by {@link markSkipped}, so callers can distinguish a
   * deliberate skip from a pending or failed attempt.
   */
  async getAll(): Promise<MentionEntry[]> {
    const store = await readStore(this.storePath);
    return [...store.entries];
  }

  /**
   * Clear the entire store. No retention pass runs first — everything is going
   * anyway, and a passing-through prune would only add a lock cycle.
   */
  async clear(): Promise<void> {
    const lf = await acquireLock(this.storePath);
    try {
      await writeStore(this.storePath, { version: STORE_VERSION, entries: [] });
    } finally {
      await releaseLock(lf);
    }
  }

  /** Get the file path this store is using. */
  getPath(): string {
    return this.storePath;
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton (uses env var or default path)
// ---------------------------------------------------------------------------

let _singleton: MentionStore | undefined;

/**
 * Get a shared MentionStore instance.
 * Callers that need independent stores should `new MentionStore(path)` directly.
 *
 * This is also where the stdio process's retention lifecycle lives: creating
 * the store starts one aging pass over it right away, and the write path then
 * runs at most one pass per RETENTION_PRUNE_INTERVAL_MS per store path. Nothing
 * is scheduled on a timer, so the server can still exit normally, and a failing
 * pass is reported on stderr rather than breaking a mention write.
 */
export function getMentionStore(): MentionStore {
  if (!_singleton) {
    const store = new MentionStore();
    _singleton = store;
    // Fire-and-forget on purpose: the pass is not in the caller's way, and the
    // first write through this instance awaits it (see retentionTick).
    void store.startRetentionPrune();
  }
  return _singleton;
}

/**
 * Forget the cached singleton so the next {@link getMentionStore()} builds a
 * fresh store — for a store path that moved, for instance. Test seam only;
 * production code should not call it.
 */
export function resetMentionStoreSingleton(): void {
  _singleton = undefined;
}

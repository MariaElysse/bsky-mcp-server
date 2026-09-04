/**
 * Persistent JSON-file-based store for tracking Bluesky mentions to prevent
 * duplicate replies.  Uses atomic writes (write-to-temp-then-rename) and a
 * simple lock mechanism so concurrent processes don't corrupt the data.
 */

import { promises as fs, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a single mention entry in the store. */
export type MentionStatus = "pending" | "replied" | "failed";

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
  /** Optional error message (set on markFailed). */
  error?: string;
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
  let releaseProcessLock: () => void;
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

/**
 * Acquire an exclusive write lock by creating a lock file.
 * Returns the absolute path of the lock file so the caller can release it.
 */
async function acquireLock(storePath: string): Promise<{ lockPath: string; releaseProcess: () => void }> {
  const releaseProcess = await acquireProcessLock(storePath);
  const lf = lockFilePath(storePath);
  let attempts = 0;
  while (attempts < MAX_WRITE_ATTEMPTS) {
    try {
      await fs.writeFile(lf, String(process.pid), { flag: "wx" });
      return { lockPath: lf, releaseProcess };
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "EEXIST") {
        attempts += 1;
        await sleep(WRITE_RETRY_MS);
      } else {
        releaseProcess();
        throw err;
      }
    }
  }
  // Fallback: overwrite lock file if stale
  try {
    await fs.writeFile(lf, String(process.pid), { flag: "w" });
  } catch {
    /* ignore */
  }
  return { lockPath: lf, releaseProcess };
}

/** Release a previously acquired lock file. */
async function releaseLock(lockInfo: { lockPath: string; releaseProcess: () => void }): Promise<void> {
  try {
    await fs.unlink(lockInfo.lockPath);
  } catch {
    /* already gone — fine */
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
    renameSync(tmp, storePath);
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
// Public API — class-based store
// ---------------------------------------------------------------------------

/**
 * Create a mention store instance backed by the configured JSON file.
 * The path is resolved once at construction time so multiple instances
 * in the same process can share state via the same file.
 */
export class MentionStore {
  private readonly storePath: string;

  constructor(storePath?: string) {
    this.storePath = storePath ?? resolveStorePath();
  }

  /** Check if a URI has already been processed (replied or failed). */
  async isHandled(uri: string): Promise<boolean> {
    const store = await readStore(this.storePath);
    return store.entries.some(
      (e) => e.uri === uri && e.status !== "pending"
    );
  }

  /** Mark a URI as being handled (status set to pending). */
  async markInProgress(uri: string): Promise<void> {
    const lf = await acquireLock(this.storePath);
    try {
      const store = await readStore(this.storePath);
      const idx = store.entries.findIndex((e) => e.uri === uri);
      if (idx !== -1) {
        // Prevent terminal-state regression: once replied/failed, never go back to pending
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

  /** Get all mentions that are still pending (unhandled). */
  async getPending(): Promise<Array<{ uri: string; timestamp: number }>> {
    const store = await readStore(this.storePath);
    return store.entries
      .filter((e) => e.status === "pending")
      .map((e) => ({ uri: e.uri, timestamp: e.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp); // oldest first
  }

  /** Remove entries older than maxAgeMs (default 24 hours). Returns count removed. */
  async cleanup(maxAgeMs?: number): Promise<number> {
    const lf = await acquireLock(this.storePath);
    try {
      const store = await readStore(this.storePath);
      const cutoff = Date.now() - (maxAgeMs ?? 24 * 60 * 60 * 1000);
      const before = store.entries.length;
      store.entries = store.entries.filter((e) => e.timestamp > cutoff);
      if (store.entries.length !== before) {
        await writeStore(this.storePath, store);
      }
      return before - store.entries.length;
    } finally {
      await releaseLock(lf);
    }
  }

  /** Get the current number of entries in the store. */
  async size(): Promise<number> {
    const store = await readStore(this.storePath);
    return store.entries.length;
  }

  /** Get all entries (useful for debugging). */
  async getAll(): Promise<MentionEntry[]> {
    const store = await readStore(this.storePath);
    return [...store.entries];
  }

  /** Clear the entire store. */
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
 */
export function getMentionStore(): MentionStore {
  if (!_singleton) {
    _singleton = new MentionStore();
  }
  return _singleton;
}

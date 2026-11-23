/**
 * Transport-level timeout, retry, and rate-limit policy for AT Protocol calls.
 *
 * Every Bluesky call this server makes goes through an `AtpAgent`, whose
 * requests funnel through a single `fetch` implementation (`AtpAgentOptions.fetch`
 * in `@atproto/api`). Installing the policy there — rather than wrapping each
 * of the ~30 call sites in `tools.ts` — means the token-refresh, login, blob
 * upload, and every read path inherit the same behaviour, and no call can block
 * the stdio loop forever behind a hung socket.
 *
 * Policy:
 * - Every request gets `AbortSignal.timeout(timeoutMs)` (default 15 s).
 * - Idempotent requests (GET/HEAD) are retried on network failure, 5xx, and 429.
 * - Non-idempotent requests (POST — record creation, likes, follows, blob
 *   upload) are never retried: a retry could post twice.
 * - A 429 honours `retry-after` / `ratelimit-reset` when the PDS provides one,
 *   capped at `MAX_RATE_LIMIT_WAIT_MS`; longer waits are surfaced to the caller
 *   instead of sleeping inside the tool call.
 * - Terminal failures throw an `Error` whose message is actionable for an LLM
 *   caller (`Rate limited by Bluesky; retry in 42s`), because `XRPCError.from()`
 *   keeps the cause message and tool handlers echo it verbatim.
 */

/** Default per-attempt timeout for every AT Protocol request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Extra attempts for idempotent requests after the first failure. */
export const DEFAULT_MAX_RETRIES = 2;

/** Upper bound on exponential backoff between attempts. */
const MAX_BACKOFF_MS = 2_000;

/** Upper bound on time spent sleeping inside a tool call waiting out a 429. */
const MAX_RATE_LIMIT_WAIT_MS = 20_000;

/** Statuses worth retrying: rate limiting and transient server faults. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface HardenedFetchOptions {
  /** Per-attempt timeout in milliseconds (default `DEFAULT_REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Retries beyond the first attempt, idempotent requests only. */
  retries?: number;
  /** Observability hook, used by tests to count retries. */
  onRetry?: (info: { attempt: number; reason: string; waitMs: number }) => void;
}

/**
 * A fetch implementation with a timeout, bounded idempotent retries, and
 * Bluesky rate-limit awareness. Pass it as the `fetch` option of `new AtpAgent`
 * (see `src/index.ts` and `defaultSearchAgentProvider` in `src/tools.ts`).
 */
export function createHardenedFetch(options: HardenedFetchOptions = {}): typeof globalThis.fetch {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_MAX_RETRIES;

  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const idempotent = method === "GET" || method === "HEAD";
    const maxAttempts = idempotent ? retries + 1 : 1;
    const target = describeTarget(input);
    let lastReason = "request failed";
    let rateLimitWaitMs: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signals = init.signal ? [timeoutSignal, init.signal] : [timeoutSignal];
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      try {
        const response = await globalThis.fetch(input, { ...init, signal });
        if (!RETRYABLE_STATUSES.has(response.status)) {
          return response;
        }
        // Release the socket before the next attempt.
        response.body?.cancel().catch(() => {});
        lastReason = `HTTP ${response.status}`;
        rateLimitWaitMs = response.status === 429 ? parseRateLimitWaitMs(response.headers) : undefined;
      } catch (error: unknown) {
        if (init.signal?.aborted) {
          throw error; // The caller cancelled; not ours to retry or reword.
        }
        lastReason = describeNetworkFailure(error, timeoutMs);
        rateLimitWaitMs = undefined;
      }

      if (attempt < maxAttempts) {
        const waitMs = nextBackoffMs(attempt, rateLimitWaitMs);
        options.onRetry?.({ attempt, reason: lastReason, waitMs });
        await sleep(waitMs);
      }
    }

    throw terminalError(target, method, maxAttempts, lastReason, rateLimitWaitMs, timeoutMs);
  };
}

/**
 * Convert an error thrown by an agent call into a message a tool can hand back
 * to an LLM caller. Timeouts and rate limits read as instructions, not stack
 * traces; anything else keeps the upstream message.
 */
export function describeAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "The Bluesky request failed without a message.";
}

/** Extract the endpoint name (`app.bsky.feed.getTimeline`) from a request URL. */
function describeTarget(input: RequestInfo | URL): string {
  let path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  try {
    path = new URL(path, "http://localhost").pathname;
  } catch {
    /* keep the raw value */
  }
  const match = path.match(/\/xrpc\/([^?]+)/);
  return match ? match[1] : path;
}

/** Classify a thrown fetch failure as a timeout or a transport error. */
function describeNetworkFailure(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") {
    return `timed out after ${timeoutMs} ms`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `transport error: ${message}`;
}

/**
 * Read the PDS's own rate-limit hint. Bluesky sends the IETF `RateLimit-*`
 * headers (`RateLimit-Reset` is seconds until the window resets) and older
 * deployments send `Retry-After` / `X-RateLimit-Reset`.
 */
function parseRateLimitWaitMs(headers: Headers): number | undefined {
  for (const key of ["retry-after", "ratelimit-reset", "x-ratelimit-reset"]) {
    const raw = headers.get(key);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return undefined;
}

/** Exponential backoff with jitter, or the PDS's own hint when it is shorter. */
function nextBackoffMs(attempt: number, rateLimitWaitMs: number | undefined): number {
  if (rateLimitWaitMs !== undefined) {
    return Math.min(rateLimitWaitMs, MAX_RATE_LIMIT_WAIT_MS);
  }
  const base = Math.min(MAX_BACKOFF_MS, 250 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Build the actionable error thrown once the attempts are exhausted. */
function terminalError(
  target: string,
  method: string,
  attempts: number,
  reason: string,
  rateLimitWaitMs: number | undefined,
  timeoutMs: number
): Error {
  const tried = attempts > 1 ? ` after ${attempts} attempts` : "";
  if (rateLimitWaitMs !== undefined) {
    const seconds = Math.max(1, Math.round(rateLimitWaitMs / 1000));
    return new Error(
      `Rate limited by Bluesky; retry in ${seconds}s. Wait and call the tool again (${target}${tried}).`
    );
  }
  if (reason.startsWith("timed out")) {
    return new Error(
      `Bluesky request ${method} ${target} ${reason}${tried} — the PDS is slow or unreachable (timeout ${timeoutMs} ms).`
    );
  }
  return new Error(`Bluesky request ${method} ${target} failed: ${reason}${tried}.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

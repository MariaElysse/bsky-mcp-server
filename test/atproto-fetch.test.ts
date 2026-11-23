#!/usr/bin/env node
/**
 * atproto-fetch — timeout, retry, and rate-limit policy for AT Protocol calls.
 *
 * Runs against a throwaway local HTTP server so the retry/timeout behaviour is
 * observed through a real socket, including one case that wires the hardened
 * fetch into a real `AtpAgent` to prove the injection point works.
 */

import assert from 'assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AtpAgent } from '@atproto/api';
import { runTests, type TestCase } from './test-helpers.js';
import {
  createHardenedFetch,
  describeAgentError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../src/atproto-fetch.js';

interface Stub {
  base: string;
  /** Paths in the order they were requested, one entry per attempt. */
  attempts: string[];
  close: () => Promise<void>;
}

/** Start an HTTP stub whose handler sees a per-path attempt counter. */
async function startStub(
  handler: (pathname: string, attempt: number, res: http.ServerResponse, req: http.IncomingMessage) => void
): Promise<Stub> {
  const counts = new Map<string, number>();
  const attempts: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    const attempt = (counts.get(pathname) ?? 0) + 1;
    counts.set(pathname, attempt);
    attempts.push(pathname);
    handler(pathname, attempt, res, req);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    base: `http://127.0.0.1:${port}`,
    attempts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

async function expectRejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the request to reject, but it resolved');
}

const tests: TestCase[] = [
  ['defaults are documented and sane', () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000);
    assert.equal(DEFAULT_MAX_RETRIES, 2);
  }],

  ['a healthy GET is a single attempt', async () => {
    const stub = await startStub((pathname, _attempt, res) => jsonResponse(res, 200, { ok: true, pathname }));
    try {
      const response = await createHardenedFetch()(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base));
      assert.equal(response.status, 200);
      assert.deepEqual(stub.attempts, ['/xrpc/app.bsky.feed.getTimeline']);
    } finally {
      await stub.close();
    }
  }],

  ['5xx is retried and the eventual success is returned', async () => {
    const stub = await startStub((_pathname, attempt, res) => {
      if (attempt < 3) {
        jsonResponse(res, 503, { error: 'Service Unavailable' });
      } else {
        jsonResponse(res, 200, { feeds: [] });
      }
    });
    const retries: Array<{ attempt: number; reason: string }> = [];
    try {
      const response = await createHardenedFetch({
        retries: 2,
        onRetry: (info) => retries.push({ attempt: info.attempt, reason: info.reason }),
      })(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base));
      assert.equal(response.status, 200);
      assert.equal(stub.attempts.length, 3, 'expected three attempts');
      assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
      assert.match(retries[0].reason, /HTTP 503/);
    } finally {
      await stub.close();
    }
  }],

  ['429 honours the retry-after hint before retrying', async () => {
    const stub = await startStub((_pathname, attempt, res) => {
      if (attempt === 1) {
        jsonResponse(res, 429, { error: 'Rate Limit Exceeded' }, { 'retry-after': '1' });
      } else {
        jsonResponse(res, 200, { feed: [] });
      }
    });
    try {
      const started = Date.now();
      const response = await createHardenedFetch({ retries: 1 })(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base));
      const waited = Date.now() - started;
      assert.equal(response.status, 200);
      assert.equal(stub.attempts.length, 2);
      assert.ok(waited >= 900, `expected the retry-after hint to be honoured, waited ${waited}ms`);
    } finally {
      await stub.close();
    }
  }],

  ['exhausted 429s produce a retry-in-Ns message instead of a raw status', async () => {
    const stub = await startStub((_pathname, _attempt, res) => {
      jsonResponse(res, 429, { error: 'Rate Limit Exceeded' }, { 'retry-after': '120' });
    });
    try {
      const started = Date.now();
      const error = await expectRejection(() =>
        createHardenedFetch({ retries: 0, timeoutMs: 5_000 })(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base))
      );
      assert.match(error.message, /Rate limited by Bluesky; retry in 120s/);
      assert.match(error.message, /app\.bsky\.feed\.getTimeline/);
      assert.ok(Date.now() - started < 5_000, 'a 120s hint must not be slept through inside the tool call');
    } finally {
      await stub.close();
    }
  }],

  ['the ratelimit-reset header is honoured when retry-after is absent', async () => {
    const stub = await startStub((_pathname, attempt, res) => {
      if (attempt === 1) {
        jsonResponse(res, 429, { error: 'Rate Limit Exceeded' }, { 'ratelimit-reset': '1' });
      } else {
        jsonResponse(res, 200, { feed: [] });
      }
    });
    try {
      const response = await createHardenedFetch({ retries: 1 })(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base));
      assert.equal(response.status, 200);
      assert.equal(stub.attempts.length, 2);
    } finally {
      await stub.close();
    }
  }],

  ['exhausted 5xx retries report the attempt count', async () => {
    const stub = await startStub((_pathname, _attempt, res) => jsonResponse(res, 502, { error: 'Bad Gateway' }));
    try {
      const error = await expectRejection(() =>
        createHardenedFetch({ retries: 1 })(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base))
      );
      assert.match(error.message, /HTTP 502/);
      assert.match(error.message, /after 2 attempts/);
      assert.equal(stub.attempts.length, 2);
    } finally {
      await stub.close();
    }
  }],

  ['POST requests are never retried, even on 5xx', async () => {
    const stub = await startStub((_pathname, _attempt, res) => jsonResponse(res, 503, { error: 'Service Unavailable' }));
    try {
      const error = await expectRejection(() =>
        createHardenedFetch({ retries: 3 })(new URL('/xrpc/com.atproto.repo.createRecord', stub.base), { method: 'POST', body: '{}' })
      );
      assert.match(error.message, /POST com\.atproto\.repo\.createRecord failed/);
      assert.doesNotMatch(error.message, /attempts/, 'a non-idempotent call must not be re-sent');
      assert.equal(stub.attempts.length, 1);
    } finally {
      await stub.close();
    }
  }],

  ['a hung PDS hits the timeout instead of blocking forever', async () => {
    const stub = await startStub(() => {
      /* never respond */
    });
    try {
      const started = Date.now();
      const error = await expectRejection(() =>
        createHardenedFetch({ timeoutMs: 300, retries: 0 })(new URL('/xrpc/app.bsky.feed.getTimeline', stub.base))
      );
      assert.match(error.message, /timed out after 300 ms/);
      assert.match(error.message, /PDS is slow or unreachable/);
      assert.ok(Date.now() - started < 3_000, 'the call should have been abandoned at the timeout');
    } finally {
      await stub.close();
    }
  }],

  ['a caller-supplied abort is passed through unchanged', async () => {
    const stub = await startStub(() => {
      /* never respond */
    });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const error = await expectRejection(() =>
        createHardenedFetch({ timeoutMs: 5_000, retries: 2 })(
          new URL('/xrpc/app.bsky.feed.getTimeline', stub.base),
          { signal: controller.signal }
        )
      );
      assert.equal(error.name, 'AbortError');
      assert.equal(stub.attempts.length, 1, 'a cancelled caller must not be retried');
    } finally {
      await stub.close();
    }
  }],

  ['the caller signal and the timeout signal are merged', async () => {
    const stub = await startStub(() => {
      /* never respond */
    });
    const controller = new AbortController();
    try {
      const error = await expectRejection(() =>
        createHardenedFetch({ timeoutMs: 300, retries: 0 })(
          new URL('/xrpc/app.bsky.feed.getTimeline', stub.base),
          { signal: controller.signal }
        )
      );
      assert.match(error.message, /timed out after 300 ms/, 'the timeout must still fire alongside a live caller signal');
    } finally {
      controller.abort();
      await stub.close();
    }
  }],

  ['non-retryable 4xx responses reach the XRPC layer untouched', async () => {
    const stub = await startStub((_pathname, _attempt, res) =>
      jsonResponse(res, 400, { error: 'InvalidRequest', message: 'Invalid handle' })
    );
    try {
      const response = await createHardenedFetch({ retries: 2 })(new URL('/xrpc/app.bsky.actor.getProfile', stub.base));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal((body as { error: string }).error, 'InvalidRequest');
      assert.equal(stub.attempts.length, 1);
    } finally {
      await stub.close();
    }
  }],

  ['an AtpAgent wired with the hardened fetch recovers from transient 5xx', async () => {
    const stub = await startStub((_pathname, attempt, res) => {
      if (attempt < 3) {
        jsonResponse(res, 500, { error: 'InternalServerError' });
      } else {
        jsonResponse(res, 200, { feed: [] });
      }
    });
    try {
      const agent = new AtpAgent({ service: stub.base, fetch: createHardenedFetch({ retries: 2 }) });
      const response = await agent.getTimeline({ limit: 5 });
      assert.deepEqual(response.data.feed, []);
      assert.equal(stub.attempts.length, 3);
    } finally {
      await stub.close();
    }
  }],

  ['an AtpAgent timeout surfaces as an actionable error message', async () => {
    const stub = await startStub(() => {
      /* never respond */
    });
    try {
      const agent = new AtpAgent({ service: stub.base, fetch: createHardenedFetch({ timeoutMs: 300, retries: 0 }) });
      const error = await expectRejection(() => agent.getTimeline({ limit: 5 }));
      assert.match(error.message, /timed out after 300 ms/, `unexpected message: ${error.message}`);
    } finally {
      await stub.close();
    }
  }],

  ['describeAgentError keeps upstream messages', () => {
    assert.equal(describeAgentError(new Error('Invalid handle')), 'Invalid handle');
    assert.match(describeAgentError('boom'), /boom/);
    assert.match(describeAgentError(new Error('')), /without a message/);
  }],
];

await runTests(tests);

// Tests for the cardyb-backed link-preview module. We stand up a local HTTP
// server to impersonate cardyb (and the cardyb image host) so the suite runs
// offline and exercises the real fetch + byte-cap code path — including the
// oversize/streaming cases that the OOM incident was about.
import assert from 'assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { runTests, type TestCase } from '../test-helpers.js';

// Point the module at our local stand-in before importing it.
const server = http.createServer((req, res) => routes(req, res));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.CARDYB_URL = base;

const { fetchLinkMetadata, uploadThumbnail } = await import('../../src/link-preview.js');

// ---- request router for the fake cardyb ------------------------------------

function routes(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', base);
  const path = url.pathname;

  // /v1/extract?url=... — behaviour is keyed off the *target* url so each test
  // can ask for a specific cardyb response.
  if (path === '/v1/extract') {
    const target = url.searchParams.get('url') ?? '';
    if (target.includes('server-error')) {
      res.writeHead(500).end('boom');
      return;
    }
    if (target.includes('cardyb-error')) {
      json(res, { error: 'could not resolve', likely_type: 'unknown', url: target, title: '', description: '', image: '' });
      return;
    }
    if (target.includes('no-title')) {
      json(res, { error: '', likely_type: 'html', url: target, title: '', description: 'desc only', image: '' });
      return;
    }
    if (target.includes('huge-json')) {
      // Valid-ish JSON but far larger than the 64 KB extract cap.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"error":"","title":"');
      for (let i = 0; i < 70 * 1024; i += 16) res.write('AAAAAAAAAAAAAAAA');
      res.end('"}');
      return;
    }
    json(res, {
      error: '',
      likely_type: 'html',
      url: target,
      title: 'Example Title',
      description: 'Example description',
      image: `${base}/v1/image?ok`,
    });
    return;
  }

  // /v1/image — fake cardyb image host with several payload shapes.
  if (path === '/v1/image') {
    if (url.search.includes('not-image')) {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      return;
    }
    if (url.search.includes('huge')) {
      // Streamed (chunked, no content-length) body over the 1 MB cap.
      res.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      for (let sent = 0; sent < 1_100_000; sent += chunk.length) res.write(chunk);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(2048, 7));
    return;
  }

  res.writeHead(404).end();
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// A minimal Agent stub that records uploadBlob calls.
function fakeAgent() {
  const calls: { bytes: number }[] = [];
  const agent = {
    uploadBlob: async (data: Uint8Array, _opts: unknown) => {
      calls.push({ bytes: data.byteLength });
      return { success: true, data: { blob: { $type: 'blob', ref: 'fake' } } };
    },
  };
  return { agent: agent as unknown as import('@atproto/api').Agent, calls };
}

// Defensive transport, body, and upload failure paths.
async function withFetch(fake: typeof fetch, test: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await test();
  } finally {
    globalThis.fetch = original;
  }
}

async function testMetadataDefensivePaths(): Promise<void> {
  await withFetch(async () => { throw new Error("network down"); }, async () => {
    assert.equal(await fetchLinkMetadata("https://example.test/network"), null);
  });

  await withFetch(async () => new Response("not json", { status: 200 }), async () => {
    assert.equal(await fetchLinkMetadata("https://example.test/bad-json"), null);
  });

  await withFetch(async () => new Response("{}", {
    status: 200,
    headers: { "content-length": String(64 * 1024 + 1) },
  }), async () => {
    assert.equal(await fetchLinkMetadata("https://example.test/declared-large"), null);
  });

  await withFetch(async () => new Response(null, { status: 200 }), async () => {
    assert.equal(await fetchLinkMetadata("https://example.test/no-body"), null);
  });
}

async function testThumbnailFailurePaths(): Promise<void> {
  await withFetch(async () => new Response("no", { status: 503 }), async () => {
    assert.equal(await uploadThumbnail({} as any, "https://img.test/status"), null);
  });

  await withFetch(async () => { throw new Error("image network down"); }, async () => {
    assert.equal(await uploadThumbnail({} as any, "https://img.test/network"), null);
  });

  await withFetch(async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  }), async () => {
    const failedUploadAgent = {
      uploadBlob: async () => ({ success: false }),
    };
    assert.equal(await uploadThumbnail(failedUploadAgent as any, "https://img.test/upload-fails"), null);

    const throwingUploadAgent = {
      uploadBlob: async () => { throw new Error("PDS upload down"); },
    };
    assert.equal(await uploadThumbnail(throwingUploadAgent as any, "https://img.test/upload-throws"), null);
  });
}

const tests: TestCase[] = [
  ['extract: maps cardyb fields', async () => {
    const meta = await fetchLinkMetadata(`${base}/page/ok`);
    assert(meta && meta.title === 'Example Title' && meta.description === 'Example description');
  }],
  ['extract: passes image URL through', async () => {
    const meta = await fetchLinkMetadata(`${base}/page/ok`);
    assert(meta && meta.imageUrl === `${base}/v1/image?ok`);
  }],
  ['extract: cardyb error field returns null', async () => {
    assert.equal(await fetchLinkMetadata('https://cardyb-error.test'), null);
  }],
  ['extract: cardyb non-200 response returns null', async () => {
    assert.equal(await fetchLinkMetadata('https://server-error.test'), null);
  }],
  ['extract: empty title falls back to URL', async () => {
    const meta = await fetchLinkMetadata('https://no-title.test/article');
    assert.equal(meta?.title, 'https://no-title.test/article');
  }],
  ['extract: oversize JSON body returns null', async () => {
    assert.equal(await fetchLinkMetadata('https://huge-json.test'), null);
  }],
  ['thumbnail: small image uploads', async () => {
    const { agent, calls } = fakeAgent();
    const blob = await uploadThumbnail(agent, `${base}/v1/image?ok`);
    assert(blob !== null && calls.length === 1 && calls[0].bytes === 2048);
  }],
  ['thumbnail: oversize image returns null without uploading', async () => {
    const { agent, calls } = fakeAgent();
    const blob = await uploadThumbnail(agent, `${base}/v1/image?huge`);
    assert.equal(blob, null);
    assert.equal(calls.length, 0);
  }],
  ['thumbnail: non-image content type returns null without uploading', async () => {
    const { agent, calls } = fakeAgent();
    const blob = await uploadThumbnail(agent, `${base}/v1/image?not-image`);
    assert.equal(blob, null);
    assert.equal(calls.length, 0);
  }],
  ['defensive metadata transport and body failures return null', testMetadataDefensivePaths],
  ['defensive thumbnail transport and upload failures return null', testThumbnailFailurePaths],
];

try {
  await runTests(tests);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// Tests for the cardyb-backed link-preview module. We stand up a local HTTP
// server to impersonate cardyb (and the cardyb image host) so the suite runs
// offline and exercises the real fetch + byte-cap code path — including the
// oversize/streaming cases that the OOM incident was about.
import assert from 'assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';

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

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`✅ ${name}`);
  } else {
    failures++;
    console.error(`❌ ${name} ${detail}`);
  }
}

// ---- fetchLinkMetadata cases -----------------------------------------------

const meta = await fetchLinkMetadata(`${base}/page/ok`);
check('extract: maps cardyb fields', !!meta && meta.title === 'Example Title' && meta.description === 'Example description', JSON.stringify(meta));
check('extract: image URL passed through', !!meta && meta.imageUrl === `${base}/v1/image?ok`);

const errCard = await fetchLinkMetadata('https://cardyb-error.test');
check('extract: cardyb error field → null', errCard === null);

const http500 = await fetchLinkMetadata('https://server-error.test');
check('extract: cardyb non-200 → null', http500 === null);

const noTitle = await fetchLinkMetadata('https://no-title.test/article');
check('extract: empty title falls back to url', noTitle?.title === 'https://no-title.test/article', JSON.stringify(noTitle));

const huge = await fetchLinkMetadata('https://huge-json.test');
check('extract: oversize JSON body → null (cap enforced)', huge === null);

// ---- uploadThumbnail cases -------------------------------------------------

{
  const { agent, calls } = fakeAgent();
  const blob = await uploadThumbnail(agent, `${base}/v1/image?ok`);
  check('thumb: small image uploads', blob !== null && calls.length === 1 && calls[0].bytes === 2048, JSON.stringify(calls));
}
{
  const { agent, calls } = fakeAgent();
  const blob = await uploadThumbnail(agent, `${base}/v1/image?huge`);
  check('thumb: oversize image → null, no upload', blob === null && calls.length === 0);
}
{
  const { agent, calls } = fakeAgent();
  const blob = await uploadThumbnail(agent, `${base}/v1/image?not-image`);
  check('thumb: non-image content-type → null, no upload', blob === null && calls.length === 0);
}

server.close();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll link-preview tests passed');

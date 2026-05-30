import type { Agent, BlobRef } from '@atproto/api';

export interface LinkMetadata {
  url: string;
  title: string;
  description: string;
  imageUrl?: string;
}

/**
 * cardyb is Bluesky's hosted link-unfurl service — the same one the official
 * app uses. It fetches the target page, extracts OpenGraph/Twitter-card
 * metadata, and resizes the card image, all behind its own byte/time/
 * content-type limits.
 *
 * Delegating to it (instead of fetching the page ourselves) is a deliberate
 * memory-safety choice: the previous in-process implementation did an
 * unbounded `response.text()` on an arbitrary, model-supplied URL and an
 * `arrayBuffer()` that only checked the 1 MB image cap *after* fully
 * buffering. A 15 s timeout bounds time, not bytes, so a single create-post
 * pointed at a large page/image could buffer hundreds of MB — which OOM'd the
 * (1.8 GiB, swapless) host on 2026-05-29. Letting cardyb do the fetching means
 * this process never reads attacker-influenced bodies and never has to defend
 * against SSRF on the third-party-controlled og:image.
 */
const CARDYB_URL = (process.env.CARDYB_URL ?? 'https://cardyb.bsky.app').replace(/\/$/, '');

// cardyb returns small JSON; cap the read anyway so a misbehaving or proxied
// endpoint can't stream unboundedly into us.
const MAX_EXTRACT_BYTES = 64 * 1024; // 64 KB
// Bluesky's thumbnail blob limit. cardyb already resizes below this, but we
// still pull the image into memory to upload it as a PDS blob, so we cap the
// read as defence in depth.
const MAX_THUMB_BYTES = 1_000_000; // 1 MB
const EXTRACT_TIMEOUT_MS = 10_000;
const THUMB_TIMEOUT_MS = 15_000;

interface CardybExtract {
  error?: string;
  likely_type?: string;
  url?: string;
  title?: string;
  description?: string;
  image?: string;
}

/**
 * Read a fetch Response body, aborting once `maxBytes` is exceeded. Returns
 * null if the declared Content-Length or the streamed size blows the cap (or
 * there's no body). This is the byte-bound the old `.text()`/`.arrayBuffer()`
 * calls lacked.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling bytes and let the connection tear down.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch link-card metadata for a URL via cardyb.
 * Returns null when no usable card can be produced (cardyb error, non-HTML
 * target, request failure, ...); callers treat that as "post without a card".
 */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata | null> {
  let response: Response;
  try {
    response = await fetch(`${CARDYB_URL}/v1/extract?url=${encodeURIComponent(url)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`cardyb extract request failed for ${url}:`, error);
    return null;
  }

  // cardyb returns a non-2xx when it can't fetch or parse the target.
  if (!response.ok) {
    console.error(`cardyb extract ${url}: HTTP ${response.status}`);
    return null;
  }

  const body = await readCapped(response, MAX_EXTRACT_BYTES);
  if (!body) {
    console.error(`cardyb extract ${url}: response exceeded ${MAX_EXTRACT_BYTES} bytes`);
    return null;
  }

  let data: CardybExtract;
  try {
    data = JSON.parse(new TextDecoder().decode(body)) as CardybExtract;
  } catch {
    console.error(`cardyb extract ${url}: invalid JSON response`);
    return null;
  }

  // cardyb signals a failed unfurl with a non-empty `error`. Not an error for
  // us — we just post without a card.
  if (data.error) {
    return null;
  }

  return {
    url: data.url || url,
    // Bluesky enforces length limits on the embed; cardyb usually trims, but
    // keep the guard so an over-long field can't be rejected at post time.
    title: (data.title || url).substring(0, 300),
    description: (data.description || '').substring(0, 1000),
    imageUrl: data.image || undefined,
  };
}

/**
 * Download a cardyb-hosted (already-resized) card image and upload it to the
 * user's PDS as a blob for use as an external-embed thumbnail.
 * Returns the BlobRef, or null on any failure / oversize.
 */
export async function uploadThumbnail(
  agent: Agent,
  imageUrl: string,
): Promise<BlobRef | null> {
  let response: Response;
  try {
    response = await fetch(imageUrl, {
      headers: { Accept: 'image/*' },
      signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`Error fetching thumbnail ${imageUrl}:`, error);
    return null;
  }

  if (!response.ok) {
    console.error(`Failed to download thumbnail ${imageUrl}: ${response.status}`);
    return null;
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    console.error(`Thumbnail URL is not an image: ${contentType}`);
    return null;
  }

  const bytes = await readCapped(response, MAX_THUMB_BYTES);
  if (!bytes) {
    console.error(`Thumbnail ${imageUrl} exceeded ${MAX_THUMB_BYTES} bytes; skipping card image`);
    return null;
  }

  try {
    const uploadResponse = await agent.uploadBlob(bytes, { encoding: contentType });
    if (!uploadResponse.success) {
      console.error('Failed to upload thumbnail blob');
      return null;
    }
    return uploadResponse.data.blob;
  } catch (error) {
    console.error('Error uploading thumbnail:', error);
    return null;
  }
}

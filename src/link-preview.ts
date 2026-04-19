import type { Agent, BlobRef } from '@atproto/api';

export interface LinkMetadata {
  url: string;
  title: string;
  description: string;
  imageUrl?: string;
}

/**
 * Fetch Open Graph metadata from a URL
 * Uses native fetch (available in Node 18+)
 */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Bluesky MCP Server/1.0',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();
    return parseOgMetadata(html, url);
  } catch (error) {
    console.error(`Error fetching link metadata for ${url}:`, error);
    return null;
  }
}

/**
 * Parse OG/Twitter Card metadata from HTML
 */
function parseOgMetadata(html: string, url: string): LinkMetadata {
  // Helper to extract meta content (handles both orders of property/content)
  const getMeta = (property: string): string | null => {
    // Pattern 1: property="..." content="..."
    const pattern1 = new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i');
    // Pattern 2: content="..." property="..."
    const pattern2 = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${property}["']`, 'i');
    // Twitter card uses 'name' instead of 'property'
    const pattern3 = new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i');
    const pattern4 = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${property}["']`, 'i');

    const match = html.match(pattern1) || html.match(pattern2) ||
                  html.match(pattern3) || html.match(pattern4);
    return match ? decodeHtmlEntities(match[1]) : null;
  };

  // Try OG tags first, fall back to Twitter Card, then standard HTML
  const title = getMeta('og:title') ||
                getMeta('twitter:title') ||
                extractTitleTag(html) ||
                url;

  const description = getMeta('og:description') ||
                      getMeta('twitter:description') ||
                      getMeta('description') ||
                      '';

  const imageUrl = getMeta('og:image') ||
                   getMeta('twitter:image') ||
                   getMeta('twitter:image:src');

  return {
    url,
    title: title.substring(0, 300), // Bluesky has length limits
    description: description.substring(0, 1000),
    imageUrl: imageUrl ? resolveUrl(imageUrl, url) : undefined,
  };
}

function extractTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].trim()) : null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function resolveUrl(imageUrl: string, baseUrl: string): string {
  try {
    return new URL(imageUrl, baseUrl).href;
  } catch {
    return imageUrl;
  }
}

/**
 * Download image and upload to Bluesky
 * Returns BlobRef for the uploaded image
 */
export async function uploadThumbnail(
  agent: Agent,
  imageUrl: string
): Promise<BlobRef | null> {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Bluesky MCP Server/1.0',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout for images
    });

    if (!response.ok) {
      console.error(`Failed to download image ${imageUrl}: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Validate it's an image
    if (!contentType.startsWith('image/')) {
      console.error(`URL is not an image: ${contentType}`);
      return null;
    }

    const imageData = await response.arrayBuffer();

    // Check size (Bluesky limit is 1MB for thumbnails)
    if (imageData.byteLength > 1000000) {
      console.error(`Image too large: ${imageData.byteLength} bytes`);
      return null;
    }

    // Upload to Bluesky
    const uploadResponse = await agent.uploadBlob(new Uint8Array(imageData), {
      encoding: contentType,
    });

    if (!uploadResponse.success) {
      console.error('Failed to upload blob');
      return null;
    }

    return uploadResponse.data.blob;
  } catch (error) {
    console.error(`Error uploading thumbnail:`, error);
    return null;
  }
}

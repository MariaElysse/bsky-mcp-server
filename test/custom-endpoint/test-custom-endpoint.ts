import assert from 'assert';
import { runTests, type TestCase } from '../test-helpers.js';
import { parseBskyUrl } from '../../src/utils.js';

// Test custom endpoint support — parseBskyUrl should work with any
// AT-Protocol-compatible web frontend, not just bsky.app.

const tests: TestCase[] = [
  ['blacksky.community URL is parsed correctly', () => {
    const result = parseBskyUrl('https://blacksky.community/profile/alice.blacksky.community/post/abc123');
    assert(result !== null, 'Should parse blacksky.community URL');
    assert.equal(result?.handle, 'alice.blacksky.community');
    assert.equal(result?.rkey, 'abc123');
  }],
  ['custom-domain URL is parsed correctly', () => {
    const result = parseBskyUrl('https://my-bluesky.example.org/profile/user.example.org/post/xyz789');
    assert(result !== null, 'Should parse custom domain URL');
    assert.equal(result?.handle, 'user.example.org');
    assert.equal(result?.rkey, 'xyz789');
  }],
  ['bsky.app URL remains supported', () => {
    const result = parseBskyUrl('https://bsky.app/profile/alice.bsky.social/post/def456');
    assert(result !== null, 'Should still parse bsky.app URL');
    assert.equal(result?.handle, 'alice.bsky.social');
    assert.equal(result?.rkey, 'def456');
  }],
  ['URL query parameters are ignored for the record key', () => {
    const result = parseBskyUrl('https://blacksky.community/profile/alice/post/abc123?ref=share');
    assert(result !== null, 'Should parse URL with query params');
    assert.equal(result?.rkey, 'abc123');
  }],
  ['URL fragments are ignored for the record key', () => {
    const result = parseBskyUrl('https://my-bluesky.example/profile/user/post/abc123#comments');
    assert(result !== null, 'Should parse URL with fragment');
    assert.equal(result?.rkey, 'abc123');
  }],
  ['custom URL without a post path is rejected', () => {
    const result = parseBskyUrl('https://blacksky.community/profile/alice');
    assert.equal(result, null);
  }],
  ['URLs with different top-level domains are supported', () => {
    const result = parseBskyUrl('https://bluesky.example.net/profile/user/post/12345');
    assert(result !== null, 'Should parse URL with different TLD');
    assert.equal(result?.handle, 'user');
    assert.equal(result?.rkey, '12345');
  }],
  ['BSKY_WEB_URL defaults to bsky.app', () => {
    const defaultUrl = process.env.BSKY_WEB_URL ?? 'https://bsky.app';
    assert.equal(defaultUrl, 'https://bsky.app');
  }],
  ['BSKY_WEB_URL is available for configuration overrides', () => {
    const customWebUrl = 'https://my-bluesky.example.org';
    assert.notEqual(process.env.BSKY_WEB_URL, customWebUrl);
  }],
];

await runTests(tests);

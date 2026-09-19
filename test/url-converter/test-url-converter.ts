import assert from 'assert';
import { runTests, type TestCase } from '../test-helpers.js';
import { parseBskyUrl } from '../../src/utils.js';

const tests: TestCase[] = [
  ['valid URL is parsed correctly', () => {
    const result = parseBskyUrl('https://bsky.app/profile/joshuashew.bsky.social/post/3llxkmoufox2l');
    assert(result !== null, 'Should parse a valid URL');
    assert.equal(result?.handle, 'joshuashew.bsky.social');
    assert.equal(result?.rkey, '3llxkmoufox2l');
  }],
  ['URL with an @ prefix is parsed correctly', () => {
    const result = parseBskyUrl('@https://bsky.app/profile/joshuashew.bsky.social/post/3llxkmoufox2l');
    assert(result !== null, 'Should parse a URL with @ prefix');
    assert.equal(result?.handle, 'joshuashew.bsky.social');
    assert.equal(result?.rkey, '3llxkmoufox2l');
  }],
  ['URL with surrounding whitespace is parsed correctly', () => {
    const result = parseBskyUrl('  https://bsky.app/profile/joshuashew.bsky.social/post/3llxkmoufox2l  ');
    assert(result !== null, 'Should parse a URL with whitespace');
    assert.equal(result?.handle, 'joshuashew.bsky.social');
    assert.equal(result?.rkey, '3llxkmoufox2l');
  }],
  ['invalid URL returns null', () => {
    assert.equal(parseBskyUrl('https://example.com/invalid/url'), null);
  }],
  ['malformed but recognizable URL returns null', () => {
    assert.equal(parseBskyUrl('bsky.app/profile/joshuashew.bsky.social/post/3llxkmoufox2l'), null);
  }],
];

await runTests(tests);

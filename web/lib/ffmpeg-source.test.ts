import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FFMPEG_ASSET_BYTES,
  FFMPEG_ASSET_SHA256,
  FFMPEG_ASSET_URL,
  FFMPEG_RELEASE_TAG,
  cachedBinaryName,
  downloadVerdict,
  ffmpegSource,
} from './ffmpeg-source.ts';

const GOOD = FFMPEG_ASSET_SHA256;
const OTHER = 'a'.repeat(64);

test('the pinned asset is the release ffmpeg-static installs from', () => {
  assert.match(FFMPEG_ASSET_URL, /^https:\/\/github\.com\/eugeneware\/ffmpeg-static\/releases\/download\//);
  assert.ok(FFMPEG_ASSET_URL.includes('/' + FFMPEG_RELEASE_TAG + '/'));
  assert.ok(FFMPEG_ASSET_URL.endsWith('/ffmpeg-linux-x64'));
  assert.match(FFMPEG_ASSET_SHA256, /^[0-9a-f]{64}$/);
  assert.ok(FFMPEG_ASSET_BYTES > 50 * 1024 * 1024);
});

test('with no overrides, the source is the pinned asset', () => {
  assert.deepEqual(ffmpegSource({}), { url: FFMPEG_ASSET_URL, sha256: GOOD });
});

test('a hosted copy can replace the URL, keeping the pinned hash unless one is given', () => {
  assert.deepEqual(ffmpegSource({ FFMPEG_DOWNLOAD_URL: 'https://x.supabase.co/storage/v1/object/public/bin/ffmpeg' }), {
    url: 'https://x.supabase.co/storage/v1/object/public/bin/ffmpeg',
    sha256: GOOD,
  });
  assert.deepEqual(ffmpegSource({ FFMPEG_DOWNLOAD_URL: 'https://mirror/ffmpeg', FFMPEG_SHA256: OTHER.toUpperCase() }), {
    url: 'https://mirror/ffmpeg',
    sha256: OTHER,
  });
});

test('a malformed hash override is ignored, not trusted', () => {
  assert.equal(ffmpegSource({ FFMPEG_SHA256: 'not-a-hash' }).sha256, GOOD);
  assert.equal(ffmpegSource({ FFMPEG_SHA256: OTHER.slice(0, 40) }).sha256, GOOD);
});

test('a download is accepted only when its hash matches', () => {
  assert.deepEqual(downloadVerdict({ bytes: FFMPEG_ASSET_BYTES, sha256: GOOD, expected: GOOD }), { ok: true });
  assert.equal(downloadVerdict({ bytes: FFMPEG_ASSET_BYTES, sha256: GOOD.toUpperCase(), expected: GOOD }).ok, true);
  const bad = downloadVerdict({ bytes: FFMPEG_ASSET_BYTES, sha256: OTHER, expected: GOOD });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'hash_mismatch');
});

test('an empty answer or an error page is refused before the hash is even compared', () => {
  const empty = downloadVerdict({ bytes: 0, sha256: GOOD, expected: GOOD });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, 'empty');
  const page = downloadVerdict({ bytes: 4096, sha256: GOOD, expected: GOOD });
  assert.equal(page.ok, false);
  if (!page.ok) assert.equal(page.reason, 'too_small');
});

test('the cache name carries the hash, so a changed pin never reuses a stale binary', () => {
  assert.notEqual(cachedBinaryName(GOOD), cachedBinaryName(OTHER));
  assert.equal(cachedBinaryName(GOOD), cachedBinaryName(GOOD.toUpperCase()));
  assert.match(cachedBinaryName(GOOD), /^ffmpeg-[0-9a-f]{16}$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MEDIA_URL_SECRET = 'test-media-key-0123456789abcdef';

import {
  MEDIA_URL_TTL_MS, MediaKeyMissing, isStreamCopyId, mediaUrlExpiry, mediaUrlIsFresh, mediaVideoUrl,
  parseMediaPathParts, parseMediaVideoUrl, parseStreamCopyId, signMediaPath, streamCopyId,
  streamCopyIdFromUrl, verifyMediaSignature,
} from './media-url.ts';
import { isBucketVideoKey } from './video-bucket-key.ts';

const ID = '1jX1Ww2M18iH6-5eM4YLZR9HKa1-PbZFo';
const OTHER = '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWM';
const BASE = 'https://media.example.com';
const EXP = mediaUrlExpiry(Date.UTC(2026, 8, 16));

test('a signature this module made verifies', () => {
  assert.deepEqual(verifyMediaSignature(ID, EXP, signMediaPath(ID, EXP)!, EXP - 1000), { ok: true });
});

test('every field is covered by the signature', () => {
  const sig = signMediaPath(ID, EXP)!;
  const at = EXP - 1000;
  // A different video, the same signature.
  assert.deepEqual(verifyMediaSignature(OTHER, EXP, sig, at), { ok: false, reason: 'bad_signature' });
  // A later expiry, the same signature — the way you would extend a link.
  assert.deepEqual(verifyMediaSignature(ID, EXP + 86_400_000, sig, at), { ok: false, reason: 'bad_signature' });
  // One nibble flipped.
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  assert.deepEqual(verifyMediaSignature(ID, EXP, flipped, at), { ok: false, reason: 'bad_signature' });
  // The wrong length must be refused, not thrown: timingSafeEqual throws on
  // unequal buffers, and a 500 here would be a crash an outsider can trigger.
  assert.deepEqual(verifyMediaSignature(ID, EXP, sig.slice(0, 63), at), { ok: false, reason: 'bad_signature' });
});

test('an expired link is expired, not forged — even with a perfect signature', () => {
  assert.deepEqual(verifyMediaSignature(ID, EXP, signMediaPath(ID, EXP)!, EXP + 1), { ok: false, reason: 'expired' });
});

test('a rotated key invalidates every outstanding URL', () => {
  const sig = signMediaPath(ID, EXP)!;
  const was = process.env.MEDIA_URL_SECRET;
  process.env.MEDIA_URL_SECRET = 'a-completely-different-key';
  try {
    assert.deepEqual(verifyMediaSignature(ID, EXP, sig, EXP - 1000), { ok: false, reason: 'bad_signature' });
  } finally { process.env.MEDIA_URL_SECRET = was; }
});

test('with no key at all it fails closed and refuses to mint', () => {
  const saved = { m: process.env.MEDIA_URL_SECRET, a: process.env.ASSISTANT_SESSION_SECRET, c: process.env.CRON_SECRET, s: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.MEDIA_URL_SECRET; delete process.env.ASSISTANT_SESSION_SECRET;
  delete process.env.CRON_SECRET; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.deepEqual(verifyMediaSignature(ID, EXP, 'f'.repeat(64), EXP - 1000), { ok: false, reason: 'no_key' });
    assert.equal(signMediaPath(ID, EXP), null);
    assert.throws(() => mediaVideoUrl(ID, BASE), MediaKeyMissing);
  } finally {
    if (saved.m) process.env.MEDIA_URL_SECRET = saved.m;
    if (saved.a) process.env.ASSISTANT_SESSION_SECRET = saved.a;
    if (saved.c) process.env.CRON_SECRET = saved.c;
    if (saved.s) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.s;
  }
});

test('the expiry is quantised to the day, so the same day mints the same URL', () => {
  // Without this, pressing Attach twice would rewrite the cache and make
  // Metricool re-fetch the whole reel for what should be one database read.
  const morning = Date.UTC(2026, 8, 16, 7, 3, 1);
  const evening = Date.UTC(2026, 8, 16, 23, 59, 59);
  assert.equal(mediaUrlExpiry(morning), mediaUrlExpiry(evening));
  assert.equal(mediaVideoUrl(ID, BASE, morning), mediaVideoUrl(ID, BASE, evening));
  // The next day mints one day further out — and only the next day does.
  assert.equal(mediaUrlExpiry(Date.UTC(2026, 8, 17, 12)) - mediaUrlExpiry(Date.UTC(2026, 8, 16, 12)), 86_400_000);
  for (const t of [morning, evening]) {
    assert.ok(mediaUrlExpiry(t) >= t + MEDIA_URL_TTL_MS);
    assert.ok(mediaUrlExpiry(t) <= t + MEDIA_URL_TTL_MS + 86_400_000);
  }
});

test('the URL ends in .mp4, and round-trips back to its parts', () => {
  const url = mediaVideoUrl(ID, BASE + '/');
  assert.ok(url.endsWith('/video.mp4'), url);
  assert.ok(url.startsWith(BASE + '/api/media/video/' + ID + '/'), url);
  const p = parseMediaVideoUrl(url)!;
  assert.equal(p.base, BASE);
  assert.equal(p.fileId, ID);
  assert.deepEqual(verifyMediaSignature(p.fileId, p.exp, p.sig, p.exp - 1000), { ok: true });
});

test('a path that is not exactly ours is refused', () => {
  const sig = 'a'.repeat(64);
  const ok = [ID, String(EXP), sig, 'video.mp4'];
  assert.ok(parseMediaPathParts(ok));
  for (const bad of [
    ok.slice(0, 3),
    [...ok, 'extra'],
    [ID, String(EXP), sig, 'video.mov'],
    ['short-id', String(EXP), sig, 'video.mp4'],
    [ID, 'soon', sig, 'video.mp4'],
    [ID, String(EXP), sig.toUpperCase(), 'video.mp4'],
    [ID, String(EXP), sig.slice(0, 63), 'video.mp4'],
    ['', '', '', ''],
  ]) assert.equal(parseMediaPathParts(bad), null, JSON.stringify(bad));
  assert.equal(parseMediaPathParts(null), null);
  assert.equal(parseMediaVideoUrl('https://media.example.com/api/other/thing'), null);
  assert.equal(parseMediaVideoUrl('not a url'), null);
});

test('freshness: the right video, the right host, and a week of life left', () => {
  const now = Date.UTC(2026, 8, 16);
  const url = mediaVideoUrl(ID, BASE, now);
  assert.equal(mediaUrlIsFresh(url, ID, BASE, now), true);
  assert.equal(mediaUrlIsFresh(url, ID, BASE + '/', now), true);
  // 25 days on, under a week remains: re-mint.
  assert.equal(mediaUrlIsFresh(url, ID, BASE, now + 25 * 86_400_000), false);
  assert.equal(mediaUrlIsFresh(url, OTHER, BASE, now), false);
  assert.equal(mediaUrlIsFresh(url, ID, 'https://elsewhere.example.com', now), false);
  assert.equal(mediaUrlIsFresh('https://drive.google.com/uc?export=download&id=' + ID, ID, BASE, now), false);
  assert.equal(mediaUrlIsFresh(null, ID, BASE, now), false);
});

test('the stream marker round-trips and is read back from a URL', () => {
  assert.equal(parseStreamCopyId(streamCopyId(ID)), ID);
  assert.equal(parseStreamCopyId('videos/' + ID + '.mp4'), null);
  assert.equal(streamCopyIdFromUrl(mediaVideoUrl(ID, BASE)), streamCopyId(ID));
  assert.equal(streamCopyIdFromUrl('https://x.supabase.co/storage/v1/object/public/content-videos/videos/' + ID + '.mp4'), null);
  assert.equal(streamCopyIdFromUrl('https://drive.google.com/uc?export=download&id=' + ID), null);
});

test('an expired URL still identifies its video', () => {
  // Identification is not authorisation. The route refuses the fetch; the
  // bookkeeping still needs to know which reel the post carries.
  const old = mediaVideoUrl(ID, BASE, Date.UTC(2020, 0, 1));
  assert.equal(streamCopyIdFromUrl(old), streamCopyId(ID));
});

test('the three kinds of copy id can never be confused for one another', () => {
  // THE SAFETY TEST. A stream marker wraps the id of the clinic's ORIGINAL
  // footage; if it ever looked like a bare Drive id, a delete dispatcher would
  // hand it to deleteDriveFile and destroy the master. If this test fails,
  // nothing else in this change matters.
  const driveId = /^[A-Za-z0-9_-]{20,80}$/;
  const cases: [string, 'drive' | 'bucket' | 'stream'][] = [
    [ID, 'drive'], [OTHER, 'drive'],
    ['videos/' + ID + '.mp4', 'bucket'],
    [streamCopyId(ID), 'stream'], [streamCopyId(OTHER), 'stream'],
  ];
  for (const [value, kind] of cases) {
    assert.equal(driveId.test(value), kind === 'drive', value);
    assert.equal(isBucketVideoKey(value), kind === 'bucket', value);
    assert.equal(isStreamCopyId(value), kind === 'stream', value);
  }
});

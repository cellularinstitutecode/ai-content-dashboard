// The rule: copy transcribed from a video may not go out without the video.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoDerived, videoVerdict, videoSourceOf, pendingLabel, pendingRefusal } from './video-required.ts';

const videoPack = { kind: 'video', sourceUrl: 'https://drive.google.com/file/d/abc/view', title: 'NK cells' };
const clipPack = { kind: 'clip', sourceUrl: 'https://youtu.be/xyz' };
const blogPack = { instagram: 'hello', blog: 'a post', linkedin: '', facebook: '' };

test('a prepared video is video-derived; a written post is not', () => {
  assert.equal(videoDerived(videoPack), true);
  assert.equal(videoDerived(blogPack), false);
});

test('an Opus clip counts too — it is equally a video', () => {
  assert.equal(videoDerived(clipPack), true);
});

test('a post with no draft at all is not video-derived', () => {
  assert.equal(videoDerived(null), false);
  assert.equal(videoDerived(undefined), false);
  assert.equal(videoDerived({}), false);
});

test('the kind is matched case-insensitively but not loosely', () => {
  assert.equal(videoDerived({ kind: 'VIDEO' }), true);
  assert.equal(videoDerived({ kind: 'videos' }), false, 'near-misses must not pass');
  assert.equal(videoDerived({ kind: 'image' }), false);
});

// The rule is about PROVENANCE, not about the network. These two cases are the
// ones most likely to be confused, so they are pinned.
test('a written TikTok post is not caught by this rule', () => {
  // It is caught by the separate needs-media rule instead.
  assert.equal(videoVerdict(blogPack, false).pending, false);
});

test('a LinkedIn post written from a transcript IS caught', () => {
  // LinkedIn takes text happily. That is not the point: the video was the source.
  assert.equal(videoVerdict(videoPack, false).pending, true);
});

test('a video-derived post that has its video is fine', () => {
  const v = videoVerdict(videoPack, true);
  assert.equal(v.pending, false);
  assert.equal(v.reason, '');
});

test('pending carries the source so one click can fix it', () => {
  const v = videoVerdict(videoPack, false);
  assert.equal(v.pending, true);
  assert.equal(v.sourceUrl, videoPack.sourceUrl);
  assert.match(v.reason, /Attach the video/);
});

// The case that cannot be fixed by clicking, and must not pretend it can.
test('a video-derived post with no recorded source says so instead', () => {
  const v = videoVerdict({ kind: 'video' }, false);
  assert.equal(v.pending, true);
  assert.equal(v.sourceUrl, null);
  assert.match(v.reason, /no longer records which video/);
  assert.match(pendingRefusal(v), /Re-prepare that row/);
});

test('the refusal tells a person what to press', () => {
  assert.match(pendingRefusal(videoVerdict(videoPack, false)), /Pending video/);
  assert.match(pendingRefusal(videoVerdict(videoPack, false)), /then approve/);
});

test('the chip stays short enough for a status slot', () => {
  assert.ok(pendingLabel().length <= 16, pendingLabel());
});

test('a blank source is treated as absent, not as an empty link', () => {
  assert.equal(videoSourceOf({ kind: 'video', sourceUrl: '   ' }), null);
  assert.equal(videoVerdict({ kind: 'video', sourceUrl: '  ' }, false).sourceUrl, null);
});

// --- the gate is actually wired up ------------------------------------------
//
// Every defect the last three audits found was in code that could not be run
// under `node --test`. The gate itself lives on route handlers that import
// `server-only`, so it cannot be called from here — but whether it is PRESENT,
// and whether it is asked the right question, can be read off the source.
//
// The right question is `videoAttached` / `angle.media.url`, never
// `media.length`: an image is an attachment and is not the video, and a gate
// asking the looser question waves through precisely the post the rule exists
// to stop.
import { readFileSync } from 'node:fs';

const readSrc = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the approve path in /api/posts is gated, on the video and not on any media', () => {
  const src = readSrc('app/api/posts/route.ts');
  assert.match(src, /videoVerdict\(draftPack, videoAttached\)/);
  assert.match(src, /error: 'video_pending'/);
  // The refusal has to be reachable — a gate whose verdict is computed and
  // then ignored is worse than none, because the test above would still pass.
  assert.match(src, /if \(verdict\.pending\)[\s\S]{0,240}NextResponse\.json/);
});

test('approveRun is gated on the matched clip, not on the hero image', () => {
  const src = readSrc('lib/autopilot.ts');
  assert.match(src, /videoVerdict\(pack as PackLike, Boolean\(run\.angle\?\.media\?\.url\)\)/);
  // And it must let the run go, not strand it in `approved` where nothing can
  // reach it — the exact defect the Autopilot audit found four times.
  assert.match(src, /if \(videoRule\.pending\)[\s\S]{0,200}releaseClaim\(/);
});

test('the video wins over a hero image when both could be sent', () => {
  // media_drive_file_id only ever holds a video. If the image were resolved
  // first, a video draft that acquired a hero image would publish the picture
  // and drop the video — silently, and past a gate that had just said yes.
  const src = readSrc('app/api/posts/route.ts');
  const videoAt = src.indexOf('existing.media_drive_file_id) {\n    try {');
  const imageAt = src.indexOf('if (!media.length && heroImage)');
  assert.ok(videoAt > 0, 'the media_drive_file_id branch was not found');
  assert.ok(imageAt > 0, 'the hero-image fallback was not found');
  assert.ok(videoAt < imageAt, 'the hero image is resolved before the video');
});

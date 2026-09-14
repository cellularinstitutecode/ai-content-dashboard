import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOWNSCALE_ABOVE_BYTES, FFMPEG_FIT_ARGS, MAX_EDGE_PX, fitDecision } from './image-fit.ts';

const MB = 1024 * 1024;

test('a small image is stored as it came', () => {
  assert.deepEqual(fitDecision('image/jpeg', 300 * 1024), { action: 'keep', why: 'small' });
  assert.deepEqual(fitDecision('image/png', DOWNSCALE_ABOVE_BYTES), { action: 'keep', why: 'small' });
});

test('a GIF is never re-encoded — that would lose the motion', () => {
  assert.deepEqual(fitDecision('image/gif', 20 * MB), { action: 'keep', why: 'gif' });
});

test('a large photo becomes a JPEG', () => {
  assert.deepEqual(fitDecision('image/jpeg', 8 * MB), { action: 'reencode', codec: 'jpeg', ext: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(fitDecision('image/webp', 2 * MB), { action: 'reencode', codec: 'jpeg', ext: 'jpg', contentType: 'image/jpeg' });
  // A parameterised type still counts.
  assert.equal(fitDecision('image/jpeg; charset=binary', 8 * MB).action, 'reencode');
});

test('a large PNG stays a PNG so transparency survives, but is downscaled', () => {
  assert.deepEqual(fitDecision('image/png', 5 * MB), { action: 'reencode', codec: 'png', ext: 'png', contentType: 'image/png' });
});

test('something that is not an image is left alone', () => {
  assert.deepEqual(fitDecision('application/pdf', 5 * MB), { action: 'keep', why: 'unknown_type' });
  assert.deepEqual(fitDecision('', 5 * MB), { action: 'keep', why: 'unknown_type' });
});

test('the ffmpeg arguments fit inside the box without enlarging, one frame only', () => {
  const args = FFMPEG_FIT_ARGS('/in.jpg', '/out.jpg', 'jpeg');
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, new RegExp("min\\(iw," + MAX_EDGE_PX + "\\)"));
  assert.match(vf, new RegExp("min\\(ih," + MAX_EDGE_PX + "\\)"));
  assert.match(vf, /force_original_aspect_ratio=decrease/);
  assert.ok(args.includes('-frames:v'));
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.ok(args.includes('-nostdin'));
  assert.equal(args[args.length - 1], '/out.jpg');
  assert.equal(args[args.indexOf('-i') + 1], '/in.jpg');
});

test('the JPEG encoder is asked for a quality no network can tell apart, and a plain pixel format', () => {
  const args = FFMPEG_FIT_ARGS('/in', '/out', 'jpeg');
  assert.equal(args[args.indexOf('-c:v') + 1], 'mjpeg');
  assert.equal(args[args.indexOf('-q:v') + 1], '3');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuvj420p');
});

test('the PNG encoder keeps PNG', () => {
  const args = FFMPEG_FIT_ARGS('/in', '/out', 'png');
  assert.equal(args[args.indexOf('-c:v') + 1], 'png');
  assert.ok(!args.includes('-q:v'));
});

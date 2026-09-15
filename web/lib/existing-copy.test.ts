import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXISTING_COPY_PER_RUN, existingCopyText, hasPreparableLink, isExistingCopyRow, queueExistingEnabled } from './existing-copy.ts';
import { isCandidate } from './video-row.ts';

const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('a row with a video and copy already written is an existing-copy row, and never a candidate', () => {
  const row = { videoLink: DRIVE, copy: 'The Vision Behind Cellular Institute…' };
  assert.equal(isExistingCopyRow(row), true);
  assert.equal(isCandidate(row), false);
  assert.equal(isExistingCopyRow({ videoLink: 'SUBS: ' + DRIVE, copy: 'x' }), true);
  assert.equal(isExistingCopyRow({ videoLink: YT, copy: 'x' }), true);
});

test('a row with empty copy is the sweep’s to write, not to queue; a row with no video is neither', () => {
  assert.equal(isExistingCopyRow({ videoLink: DRIVE, copy: '' }), false);
  assert.equal(isCandidate({ videoLink: DRIVE, copy: '' }), true);
  assert.equal(isExistingCopyRow({ videoLink: DRIVE, copy: '   ' }), false);
  assert.equal(isExistingCopyRow({ videoLink: '', copy: 'copy' }), false);
  assert.equal(isExistingCopyRow({ videoLink: 'Posts-1-Marzo.jpg', copy: 'copy' }), false);
  assert.equal(isExistingCopyRow({ videoLink: 'https://vimeo.com/12345', copy: 'copy' }), false);
});

test('the link rule matches the candidate rule’s idea of a video', () => {
  assert.equal(hasPreparableLink(DRIVE), true);
  assert.equal(hasPreparableLink(YT), true);
  assert.equal(hasPreparableLink('https://example.com/a.mp4'), false);
  assert.equal(hasPreparableLink(''), false);
});

test('the copy goes out as written — trimmed, line endings normalised, nothing added', () => {
  assert.equal(existingCopyText('  Hello\r\nworld \r\n'), 'Hello\nworld');
  assert.equal(existingCopyText(''), '');
  assert.doesNotMatch(existingCopyText('plain copy'), /AVISO|REF/);
});

test('queuing existing copy is on unless switched off', () => {
  assert.equal(queueExistingEnabled({}), true);
  assert.equal(queueExistingEnabled({ VIDEO_QUEUE_EXISTING_COPY: 'on' }), true);
  for (const off of ['off', 'OFF', 'false', '0', 'no']) assert.equal(queueExistingEnabled({ VIDEO_QUEUE_EXISTING_COPY: off }), false, off);
  assert.ok(EXISTING_COPY_PER_RUN >= 10 && EXISTING_COPY_PER_RUN <= 50);
});

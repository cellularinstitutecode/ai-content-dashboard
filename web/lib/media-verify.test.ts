import test from 'node:test';
import assert from 'node:assert/strict';
import { isMp4Header, judgeMp4Probe, totalLengthFromRange } from './media-verify.ts';

// 00 00 00 18 'f' 't' 'y' 'p' 'mp42' … — the head of a real MP4.
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);
const HTML = new Uint8Array(Buffer.from('<!DOCTYPE html><html>', 'latin1'));

test('the MP4 signature is ftyp at offset 4, and nothing else passes', () => {
  assert.equal(isMp4Header(MP4), true);
  assert.equal(isMp4Header(HTML), false);
  assert.equal(isMp4Header(new Uint8Array([0, 0, 0])), false);
});

test('the total length is read from Content-Range', () => {
  assert.equal(totalLengthFromRange('bytes 0-15/143870376'), 143870376);
  assert.equal(totalLengthFromRange('bytes 0-15/*'), null);
  assert.equal(totalLengthFromRange(null), null);
});

test('a real MP4 of the right size passes', () => {
  const v = judgeMp4Probe({ status: 206, contentRange: 'bytes 0-15/143870376', firstBytes: MP4 }, 143870376);
  assert.deepEqual(v, { ok: true, length: 143870376 });
});

test('Google’s download page is named for what it is', () => {
  const v = judgeMp4Probe({ status: 200, contentType: 'text/html; charset=utf-8', contentLength: '2100', firstBytes: HTML }, 143870376);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.reason, 'not_mp4');
    assert.match(v.message, /web page, not the video/);
  }
});

test('a truncated or different file is a size mismatch', () => {
  const v = judgeMp4Probe({ status: 206, contentRange: 'bytes 0-15/1000', firstBytes: MP4 }, 143870376);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'size_mismatch');
});

test('an unknown source size skips the length check; a server that ignores Range still counts', () => {
  assert.equal(judgeMp4Probe({ status: 206, contentRange: 'bytes 0-15/999', firstBytes: MP4 }, null).ok, true);
  const full = judgeMp4Probe({ status: 200, contentLength: '143870376', firstBytes: MP4 }, 143870376);
  assert.deepEqual(full, { ok: true, length: 143870376 });
});

test('anything but 200/206 is unreachable', () => {
  const v = judgeMp4Probe({ status: 403, firstBytes: MP4 }, 1);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'unreachable');
});

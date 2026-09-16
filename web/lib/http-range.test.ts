import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardableRange } from './http-range.ts';

test('the probe media-verify sends is forwarded unchanged', () => {
  // lib/media-verify.ts asks for bytes=0-15 anonymously; if this one header
  // did not survive, every verification would download the whole reel.
  assert.equal(forwardableRange('bytes=0-15'), 'bytes=0-15');
});

test('open-ended, suffix and mid-file ranges are forwarded', () => {
  assert.equal(forwardableRange('bytes=0-'), 'bytes=0-');
  assert.equal(forwardableRange('bytes=-500'), 'bytes=-500');
  assert.equal(forwardableRange('bytes=1048576-2097151'), 'bytes=1048576-2097151');
});

test('whitespace and case are normalised, not rejected', () => {
  assert.equal(forwardableRange(' Bytes = 0 - 15 '), 'bytes=0-15');
});

test('a multi-range request is dropped, not forwarded', () => {
  // Drive would answer multipart/byteranges, and this route copies Drive's
  // content-type through — so the caller would be handed a MIME document
  // where it asked for a video. No header means the whole file, which is a
  // correct answer to any Range request.
  assert.equal(forwardableRange('bytes=0-1,5-6'), null);
});

test('anything that is not one byte range is dropped', () => {
  for (const h of ['items=0-10', 'bytes=abc', 'bytes=', 'bytes', '', null, undefined, 'bytes=-0']) {
    assert.equal(forwardableRange(h as string), null, String(h));
  }
});

test('an absurdly long header is dropped without parsing', () => {
  assert.equal(forwardableRange('bytes=' + '0-1,'.repeat(60)), null);
});

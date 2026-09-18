// web/lib/data-url.test.ts
//
// "If we could put a drop box, like if we were talking to GPT, dropping
//  pictures… because honestly the photos look too AI."
//
// A file arriving from a browser is the one input on this path that a stranger
// could shape, and it lands in a PUBLIC bucket. So it is read rather than
// trusted: the type must be an image this app is willing to serve, the bytes
// must actually be that image, and the size must be one the platform will
// carry. Every refusal says what to do about it, because it is read by somebody
// standing over a drag-and-drop box wondering why nothing happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_BYTES, decodeDataUrl, looksLike } from './data-url.ts';

const jpeg = (extra = 16) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 7)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 1)]);
const asDataUrl = (type: string, bytes: Buffer) => 'data:' + type + ';base64,' + bytes.toString('base64');

test('a real photograph comes through', () => {
  const out = decodeDataUrl(asDataUrl('image/jpeg', jpeg()));
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.contentType, 'image/jpeg');
    assert.equal(out.ext, 'jpg');
    assert.equal(out.bytes.length, 20);
  }
  assert.equal(decodeDataUrl(asDataUrl('image/png', png())).ok, true);
  // image/jpg is what some cameras write; it is the same thing.
  const odd = decodeDataUrl(asDataUrl('image/jpg', jpeg()));
  assert.equal(odd.ok && odd.contentType, 'image/jpeg');
});

test('a file that is not the image it claims to be is refused', () => {
  // A JPEG header on something else is how a public bucket ends up serving
  // what nobody meant to publish.
  const lying = decodeDataUrl(asDataUrl('image/png', jpeg()));
  assert.equal(lying.ok, false);
  if (!lying.ok) assert.match(lying.message, /contents are not/);
});

test('only formats a network will show', () => {
  // SVG is a document that can carry script, and it is deliberately absent.
  const svg = decodeDataUrl('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'));
  assert.equal(svg.ok, false);
  if (!svg.ok) assert.match(svg.message, /JPEG, PNG, WebP or GIF/);
  const pdf = decodeDataUrl('data:application/pdf;base64,' + Buffer.from('%PDF-1.4').toString('base64'));
  assert.equal(pdf.ok, false);
});

test('a photograph too big to send says so in megabytes, not in bytes', () => {
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_IMAGE_BYTES, 3)]);
  const out = decodeDataUrl(asDataUrl('image/jpeg', huge));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.message, /MB/);
    assert.match(out.message, /exported smaller/);
  }
});

test('nothing, or nonsense, is refused kindly', () => {
  for (const v of ['', '   ', 'not a data url', 'data:image/jpeg;base64,', null, undefined]) {
    const out = decodeDataUrl(v as string);
    assert.equal(out.ok, false, JSON.stringify(v));
    if (!out.ok) assert.ok(out.message.length > 10, 'and says something useful: ' + out.message);
  }
});

test('the magic numbers are the ones these formats actually start with', () => {
  assert.equal(looksLike('image/jpeg', jpeg()), true);
  assert.equal(looksLike('image/png', png()), true);
  assert.equal(looksLike('image/gif', Buffer.from('GIF89a' + 'x'.repeat(8))), true);
  assert.equal(looksLike('image/webp', Buffer.from('RIFF1234WEBPVP8 ')), true);
  assert.equal(looksLike('image/webp', Buffer.from('RIFF1234AVI WHAT')), false);
  assert.equal(looksLike('image/jpeg', Buffer.alloc(4)), false, 'too short to judge is not a pass');
});

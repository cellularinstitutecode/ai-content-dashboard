// web/lib/metricool-normalize-parse.test.ts
//
// THE 477 MB THAT WAS THROWN AWAY. The clinic pressed Send on a four-minute
// reel, three networks at once, and got:
//
//   "Metricool answered, but not with a reference this app could read, so the
//    video would have been dropped silently. The file is 477 MB. The video link
//    this app handed over is fine (477 MB), so the file itself is not the
//    problem."
//
// The file had already crossed the wire. Metricool had taken it. The post was
// refused because the reply did not use one of the five key shapes this app
// knew — and the reader looked into `data` only when `data` was an OBJECT, so
// `{"data": "https://…"}` went straight through it.
//
// Two rules are asserted below, and they pull against each other on purpose:
//   1. Find the reference in any reasonable answer. A key name is not a reason
//      to discard a video that has already been uploaded.
//   2. Never invent one. A wrong URL is posted as the clinic's video, which is
//      worse than a refusal that says what it could not read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeShape, readNormalizedUrl } from './metricool-normalize-parse.ts';
import { normalizeFailure } from './media-normalize-reason.ts';

const SENT = 'https://studio.example.com/api/media/video/abc/1800000000/ff/video.mp4';
const THEIRS = 'https://cdn.metricool.com/media/9f3a2b.mp4';

test('the shape that caused this is read', () => {
  // The one that fell through: data holding the URL itself.
  assert.equal(readNormalizedUrl(JSON.stringify({ data: THEIRS }), SENT).url, THEIRS);
});

test('and every other shape a REST API plausibly answers with', () => {
  const shapes: Record<string, unknown> = {
    'bare string': THEIRS,
    'quoted string': undefined, // handled separately below
    '{url}': { url: THEIRS },
    '{data:{url}}': { data: { url: THEIRS } },
    '{result}': { result: THEIRS },
    '{data:{media:{src}}}': { data: { media: { src: THEIRS } } },
    'array': [{ url: THEIRS }],
    '{status,data:[{file}]}': { status: 'OK', data: [{ file: THEIRS }] },
    '{normalizedUrl}': { normalizedUrl: THEIRS },
    '{location}': { location: THEIRS },
  };
  for (const [name, body] of Object.entries(shapes)) {
    if (body === undefined) continue;
    assert.equal(readNormalizedUrl(JSON.stringify(body), SENT).url, THEIRS, name);
  }
  assert.equal(readNormalizedUrl('"' + THEIRS + '"', SENT).url, THEIRS, 'quoted string');
  assert.equal(readNormalizedUrl(THEIRS, SENT).url, THEIRS, 'not even JSON');
});

test('a media-ish key wins over a URL that is merely present', () => {
  // Their error pages and doc links live in the same body as the reference.
  const body = { help: 'https://app.metricool.com/resources/apidocs/index.html', data: { url: THEIRS } };
  assert.equal(readNormalizedUrl(JSON.stringify(body), SENT).url, THEIRS);
});

test('our own URL handed back is not a normalise', () => {
  // The file never moved. Returning it would report success for a post that
  // Metricool then publishes with no video — the exact silent failure all of
  // this exists to prevent. The caller's unchanged-means-degraded check then
  // catches it, which it cannot do if we hand back THEIR url instead.
  const both = { requested: SENT, data: { url: THEIRS } };
  assert.equal(readNormalizedUrl(JSON.stringify(both), SENT).url, THEIRS, 'prefer the one that is not ours');
  assert.equal(readNormalizedUrl(JSON.stringify({ url: SENT }), SENT).url, SENT, 'an echo is still reported, for the caller to refuse');
});

test('nothing is invented', () => {
  // These must all fail. A post is refused on each — correctly.
  const empty = [
    '{}',
    '{"status":"queued","data":null}',
    '{"ok":true}',
    '',
    'Internal Server Error',
    '{"count": 3}',
  ];
  for (const body of empty) {
    assert.equal(readNormalizedUrl(body, SENT).url, null, JSON.stringify(body));
  }
});

test('an opaque id counts only when there is no URL at all', () => {
  assert.equal(readNormalizedUrl('{"mediaId":"9f3a2b"}', SENT).url, '9f3a2b');
  // …and never in preference to a real one.
  assert.equal(readNormalizedUrl(JSON.stringify({ id: '12345', data: { url: THEIRS } }), SENT).url, THEIRS);
  // An id with spaces is a sentence, not a reference.
  assert.equal(readNormalizedUrl('{"id":"not a file"}', SENT).url, null);
});

test('what it could not read is described in TYPES, never values', () => {
  const body = '{"status":"queued","data":null,"token":"sk-secret-value"}';
  const out = readNormalizedUrl(body, SENT);
  assert.equal(out.url, null);
  assert.match(out.shape, /status:string/);
  assert.match(out.shape, /data:null/);
  assert.ok(!out.shape.includes('sk-secret-value'), 'a response body is not ours to display');
  assert.ok(!out.shape.includes('queued'), 'types, not values');
});

test('describeShape stays short on a large answer', () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) big['k' + i] = i;
  const shape = describeShape(big);
  assert.ok(shape.length < 120, 'a diagnosis nobody can read is not a diagnosis: ' + shape.length);
  assert.equal(describeShape({ a: { b: { c: { d: 1 } } } }), '{a:{b:{…}}}');
});

test('the message names the shape, so the next unknown answer is a five-minute fix', () => {
  const out = normalizeFailure({ status: 200, shape: '{data:string, status:number}', sizeBytes: 477 * 1024 * 1024 });
  assert.equal(out.reason, 'unreadable');
  assert.match(out.message, /477 MB/);
  assert.match(out.message, /It replied with \{data:string, status:number\}\./);
});

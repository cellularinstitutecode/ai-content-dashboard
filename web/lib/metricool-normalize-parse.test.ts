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
import { attemptTrace, normalizeFailure } from './media-normalize-reason.ts';
import { readFileSync } from 'node:fs';

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

test('the message says which endpoints were tried and what each answered', () => {
  // Every other call in lib/metricool.ts is versioned (/v2/scheduler/posts) and
  // the normalise was not. From this sandbox there is no way to ask which
  // spelling is right — app.metricool.com is blocked — so both are tried and
  // the answer is reported instead of guessed at for another round.
  const attempts = [
    { path: '/v2/actions/normalize/video/url', status: 404 },
    { path: '/actions/normalize/video/url', status: 200 },
  ];
  assert.equal(attemptTrace(attempts), 'v2/video 404 \u00b7 video 200');
  const out = normalizeFailure({ status: 200, shape: '{status:string}', attempts });
  assert.match(out.message, /Tried v2\/video 404 · video 200\./);
  // Nothing to report is nothing said, rather than an empty clause.
  assert.equal(attemptTrace([]), '');
  assert.ok(!/Tried/.test(normalizeFailure({ status: 200 }).message));
});

test('a 404 from every endpoint reads as "no such endpoint", not "your file is broken"', () => {
  const out = normalizeFailure({
    status: 404,
    attempts: [{ path: '/v2/actions/normalize/video/url', status: 404 }, { path: '/actions/normalize/video/url', status: 404 }],
  });
  assert.match(out.message, /no such endpoint/);
  assert.match(out.message, /Tried/);
});

// --- THE HOLE THAT COST TWO ROUNDS -----------------------------------------
//
// "nope still" — the same sentence, three sends running, with none of the new
// diagnosis in it. The reason was not the deploy. It was this: when Metricool's
// answer held no URL but OURS, the reader found a URL, reported success, and
// the caller then marked the post degraded WITHOUT recording a failure. So the
// message printed the bare fallback — no status, no shape, no endpoints — which
// is byte-identical to the old one.
//
// An echo is a failure. It is the failure that looks most like success, which
// is exactly why it has to be named.

test('an echo is its own cause, not "unreadable"', () => {
  const out = normalizeFailure({
    status: 200,
    echoed: true,
    shape: '{url:string}',
    sizeBytes: 477 * 1024 * 1024,
    attempts: [{ path: '/v2/actions/normalize/video/url', status: 200, method: 'GET' }],
  });
  assert.equal(out.reason, 'echo');
  assert.match(out.message, /handed the same link straight back/);
  assert.match(out.message, /did not take the file/);
  assert.match(out.message, /477 MB/);
  assert.match(out.message, /It replied with \{url:string\}\./, 'the shape rides along, as it must for any diagnosis');
  assert.match(out.message, /Tried/);
  // And it is NOT the sentence it was indistinguishable from.
  assert.ok(!/not with a reference this app could read/.test(out.message));
});

test('no degraded post can reach the screen without a diagnosis', () => {
  // A source check, because the hole was in the wiring rather than in any one
  // function: normalizeMediaList marked `degraded` and left `failure` null, so
  // there was nothing to explain it with. Every branch that degrades must
  // record why.
  const src2 = readFileSync(new URL('../lib/metricool.ts', import.meta.url), 'utf8');
  const list = src2.slice(src2.indexOf('export async function normalizeMediaList'));
  const degradeLines = list.split('\n').filter((l) => /degraded = true/.test(l)).length;
  assert.ok(degradeLines >= 2, 'expected the two degrade branches');
  assert.match(list, /if \(!failure\) failure = \{ \.\.\.out, ok: false, echoed: true \}/,
    'the echo branch must record the failure it is refusing on');
});

test('the method is tried both ways, and the trace says which', () => {
  const src2 = readFileSync(new URL('../lib/metricool.ts', import.meta.url), 'utf8');
  assert.match(src2, /\['GET', 'POST'\] as const/, 'an upload action is as likely to be a POST, and it had never been tried');
  assert.equal(
    attemptTrace([
      { path: '/v2/actions/normalize/video/url', status: 404, method: 'GET' },
      { path: '/actions/normalize/video/url', status: 200, method: 'POST' },
    ]),
    'v2/video 404 · video POST 200',
    'GET is the default and stays unsaid; POST is the fact worth printing',
  );
});

// --- THE REGRESSION: STOPPING ON A STATUS RATHER THAN ON AN ANSWER ----------
//
// "I tried 186, which wasn't as large of a file, and it still didn't go
//  through." Size was never the variable.
//
// Until #249 there was ONE call here — /actions/normalize/image/url — and every
// video reached Metricool through it. #249 added a /video/ endpoint, tried it
// first, and broke out of the loop on the first response that was merely `ok`.
// The moment that endpoint answered 200 with something that is not a media
// reference, this app stopped and never reached the endpoint that had been
// working. Every video since failed at the door, whatever its size.

test('the loop stops on a usable answer, not on a status', () => {
  const src2 = readFileSync(new URL('../lib/metricool.ts', import.meta.url), 'utf8');
  const fn = src2.slice(src2.indexOf('export async function normalizeMediaDetailed'), src2.indexOf('/** The URL to post'));
  // A non-ok response continues to the next endpoint…
  assert.match(fn, /if \(!res\.ok\) \{[\s\S]*?continue;/, 'a refusal must not end the search');
  // …and so does a 200 that yields nothing usable. This is the line whose
  // absence cost every video for two days.
  assert.ok(!/if \(res\.ok\)[\s\S]{0,80}break/.test(fn), 'breaking on a status is the bug itself');
  assert.match(fn, /parsed\.url && !sameUrl\(parsed\.url, url\)/, 'only a reference that is not our own ends it');
  // The endpoint that worked before the regression leads.
  const order = fn.slice(fn.indexOf('const paths ='), fn.indexOf('const budgetMs'));
  assert.ok(
    order.indexOf("'/actions/normalize/image/url'") < order.indexOf("'/actions/normalize/video/url'"),
    'the path that demonstrably worked is tried first: "it worked" beats every theory about which is more correct',
  );
});

test('trying harder cannot run the request off its own clock', () => {
  // Metricool PULLS the file, so two attempts on a 477 MB reel is two
  // transfers. Four attempts at four minutes each is twenty minutes inside a
  // five-minute function: the platform kills it and the person sees nothing at
  // all, which is worse than a named refusal.
  const src2 = readFileSync(new URL('../lib/metricool.ts', import.meta.url), 'utf8');
  const fn = src2.slice(src2.indexOf('export async function normalizeMediaDetailed'), src2.indexOf('/** The URL to post'));
  assert.match(fn, /const deadline = Date\.now\(\) \+ budgetMs/, 'one clock across every attempt');
  assert.match(fn, /timeoutMs: left/, 'each attempt gets what is left, not a fresh four minutes');
  assert.match(fn, /if \(left < 10_000\) break/, 'and an attempt that cannot finish is not started');
});

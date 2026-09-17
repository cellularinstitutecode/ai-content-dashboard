// web/lib/media-normalize-reason.test.ts
//
// THE FAILURE THIS IS ABOUT. Three networks at once, one sentence for all of
// them: "Metricool did not take the video, so the post was not created. Try
// again in a moment; if it keeps happening, the video copy needs a look."
//
// The clinic pressed Send on a four-minute reel and got that, three times over.
// It fits a file Metricool thinks is too large, a rejected token, a 502 at
// their end, a link that expired and a transfer that ran out of time — and for
// four of those, "try again in a moment" is the wrong advice and "the video
// copy needs a look" sends somebody to inspect the one thing that was working.
//
// The status code was known at the moment that sentence was written. These
// tests are about never throwing it away again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaHandoverMessage, normalizeFailure, ourLinkNote, readableSize } from './media-normalize-reason.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a size is a size, not a byte count', () => {
  assert.equal(readableSize(512 * 1024 * 1024), '512 MB');
  assert.equal(readableSize(1.8 * 1024 ** 3), '1.8 GB');
  assert.equal(readableSize(2 * 1024 ** 3), '2 GB');
  assert.equal(readableSize(4096), '4 KB');
  assert.equal(readableSize(0), '');
  assert.equal(readableSize(null), '');
});

test('each cause gets its own sentence and its own next step', () => {
  const tooBig = normalizeFailure({ status: 413, sizeBytes: 900 * 1024 * 1024 });
  assert.equal(tooBig.reason, 'refused');
  assert.match(tooBig.message, /too large \(413\)/);
  assert.match(tooBig.message, /900 MB/, 'the size is the fact that makes 413 actionable');

  const auth = normalizeFailure({ status: 403 });
  assert.equal(auth.reason, 'auth');
  assert.match(auth.message, /will not fix itself/, 'nobody should be told to retry a bad token');

  const upstream = normalizeFailure({ status: 502 });
  assert.equal(upstream.reason, 'upstream');
  assert.match(upstream.message, /their end/);

  const rate = normalizeFailure({ status: 429 });
  assert.equal(rate.reason, 'upstream');
  assert.match(rate.message, /wait a minute/);

  const timeout = normalizeFailure({ error: 'Metricool timed out after 240s' });
  assert.equal(timeout.reason, 'timeout');
  assert.match(timeout.message, /ran out of time/);

  const dead = normalizeFailure({ error: 'fetch failed: ECONNRESET' });
  assert.equal(dead.reason, 'unreachable');
});

test('a 200 nobody could read is its own case', () => {
  // Metricool answering 200 with a shape this app cannot parse is the failure
  // that used to be indistinguishable from success: the raw URL went into the
  // post and was dropped in silence.
  const out = normalizeFailure({ status: 200 });
  assert.equal(out.reason, 'unreadable');
  assert.match(out.message, /dropped silently/);
});

test('a status and a transport error are never merged', () => {
  // They call for opposite next steps: one is "Metricool said no", the other is
  // "we never heard from Metricool".
  const both = normalizeFailure({ status: 500, error: 'aborted' });
  assert.equal(both.reason, 'timeout', 'the error wins — there is no trustworthy status behind it');
  assert.equal(both.status, null);
});

test('the message says what OUR side of the link did, because that is where people were sent to look', () => {
  const failure = normalizeFailure({ status: 403 });
  const whole = mediaHandoverMessage(failure, ourLinkNote({ ok: true, bytes: 512 * 1024 * 1024 }));
  assert.match(whole, /unauthorised \(403\)/);
  assert.match(whole, /link this app handed over is fine \(512 MB\)/);
  assert.match(whole, /not the problem/, 'the old advice sent somebody to check exactly this');

  const broken = mediaHandoverMessage(failure, ourLinkNote({ ok: false, message: 'HTTP 404' }));
  assert.match(broken, /did not answer either: HTTP 404/);

  // No probe, no invented reassurance.
  assert.equal(mediaHandoverMessage(failure, ourLinkNote(null)), failure.message);
});

// --- THE BUG THAT MADE THIS UNFIXABLE BY RETRYING ---------------------------

test('the route that hands Metricool a video can outlive the transfer it starts', () => {
  // lib/metricool.ts gives a VIDEO normalise four minutes, because Metricool is
  // pulling a 96 MB - 1.8 GB file onto its own storage before it answers. The
  // schedule route ran with maxDuration = 60. A 240-second step inside a
  // 60-second function cannot finish: the platform kills the request and
  // returns a bodyless 504 on exactly the posts carrying the biggest files.
  const route = src('app/api/metricool/schedule/route.ts');
  const declared = /export const maxDuration = (\d+)/.exec(route);
  assert.ok(declared, 'the schedule route must declare a duration');
  const seconds = Number(declared![1]);
  const videoNormalizeMs = Number(/const timeoutMs = isVideo \? (\d+)_000/.exec(src('lib/metricool.ts'))?.[1] || 0);
  assert.ok(videoNormalizeMs > 0, 'the video normalise timeout must be readable');
  assert.ok(
    seconds >= videoNormalizeMs,
    'the route allows ' + seconds + 's for a normalise it permits to run ' + videoNormalizeMs + 's',
  );
});

test('every door that hands over a video names the reason it was refused', () => {
  // A pure function nothing calls is not an explanation.
  for (const path of ['app/api/metricool/schedule/route.ts', 'app/api/posts/route.ts', 'lib/video-attach.ts']) {
    assert.match(src(path), /normalizeFailure\(/, path + ' must say WHY Metricool refused the video');
  }
  // And the old one-size sentence is gone from all of them.
  for (const path of ['app/api/metricool/schedule/route.ts', 'app/api/posts/route.ts', 'lib/video-attach.ts']) {
    assert.ok(
      !/the video copy needs a look/.test(src(path)),
      path + ' still sends people to inspect the video copy whatever went wrong',
    );
  }
});

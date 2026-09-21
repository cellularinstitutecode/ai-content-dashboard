// web/lib/copy-source.test.ts
//
// "Why did the past runs go through on Metricool? There was something done
//  right from 180 and 182, because those videos actually went through."
//
// There was, and it is datable to the hour. On 15 September #249 (17:11) began
// staging each video in a Supabase bucket and handing Metricool a public
// supabase.co URL — that is what 180 and 182 used. #253 (19:04) changed what
// happens when the file is over the project's 50 MB cap: instead of a bucket
// URL, Metricool is handed THIS APP'S OWN streaming URL.
//
// The app runs on Vercel. A function there streams through AWS Lambda, which
// caps response streaming far below one reel — so that URL serves a browser
// (small ranges, first chunks) and cannot serve Metricool (the whole file).
// Every video since has been handed a link that could not deliver it, whatever
// its size, which is why a 40 MB row failed beside a 477 MB one.
//
// The streaming route said so in its own comment while it was being written.
// Nothing enforced it. These tests are the enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DRIVE_DIRECT_MAX_BYTES, cachedCopyUsable, copyRouteFor, servesWholeVideos } from './copy-source.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MB = 1024 * 1024;
const VERCEL = { VERCEL_PROJECT_PRODUCTION_URL: 'ai-content-dashboard-pi.vercel.app' };

test('a Vercel function is not a host that can hand Metricool a whole reel', () => {
  assert.equal(servesWholeVideos('https://ai-content-dashboard-pi.vercel.app', {}), false);
  // Including behind a custom domain, which has no outward sign at all.
  assert.equal(servesWholeVideos('https://studio.cellular.example', VERCEL), true, 'a different host is not the Vercel one');
  assert.equal(servesWholeVideos('https://ai-content-dashboard-pi.vercel.app', VERCEL), false);
  // A host somebody configured FOR THIS is trusted: that is what the setting is.
  assert.equal(
    servesWholeVideos('https://media.cellular.example', { ...VERCEL, PUBLIC_MEDIA_BASE_URL: 'https://media.cellular.example' }),
    true,
  );
  assert.equal(servesWholeVideos('', {}), false, 'no address is not a host that serves anything');
});

test('the bucket still wins when the file fits — the path 180 and 182 used', () => {
  assert.deepEqual(copyRouteFor({ staged: true, sizeBytes: 40 * MB, base: 'https://x.vercel.app', env: VERCEL }), { source: 'bucket' });
});

test('under Google’s scan threshold, a Drive copy serves the file itself', () => {
  // The oldest path here, and it works. #253 demoted it to a rescue for a
  // problem that only exists ABOVE this size.
  assert.deepEqual(copyRouteFor({ staged: false, sizeBytes: 80 * MB, base: 'https://x.vercel.app', env: VERCEL }), { source: 'drive' });
  assert.deepEqual(copyRouteFor({ staged: false, sizeBytes: DRIVE_DIRECT_MAX_BYTES, base: 'https://x.vercel.app', env: VERCEL }), { source: 'drive' });
  // Above it, Google answers with its virus-scan page, which Metricool stored
  // as the video once already.
  assert.notEqual(copyRouteFor({ staged: false, sizeBytes: 120 * MB, base: 'https://media.example', env: {} }).source, 'drive');
});

test('a big file streams only from a host that can stream it', () => {
  assert.deepEqual(
    copyRouteFor({ staged: false, sizeBytes: 477 * MB, base: 'https://media.example', env: { PUBLIC_MEDIA_BASE_URL: 'https://media.example' } }),
    { source: 'stream' },
  );
});

test('and is REFUSED, by name, when the only address is a Vercel function', () => {
  // The whole failure, said out loud at the moment the copy is made, instead of
  // as "Metricool did not take the video" an hour later.
  const out = copyRouteFor({ staged: false, sizeBytes: 477 * MB, base: 'https://ai-content-dashboard-pi.vercel.app', env: VERCEL });
  assert.equal(out.source, 'refuse');
  const message = out.source === 'refuse' ? out.message : '';
  assert.match(message, /477 MB/);
  assert.match(message, /PUBLIC_MEDIA_BASE_URL/, 'the setting that fixes it is named');
  assert.match(message, /180 and 182/, 'and the fact that dates it');
  assert.match(message, /under 100 MB/, 'with the answer that needs nobody');
  // ALL THREE ROUTES. The message used to offer two, and the one it left out is
  // the bucket — the route rows 180 and 182 actually went out on, and the only
  // one already proven from this deployment. Somebody reading the old text
  // would have gone and bought a container they may not have needed.
  assert.match(message, /SUPABASE_UPLOAD_MAX_BYTES/, 'the proven route must be offered');
  assert.match(message, /Storage → Settings/, 'and where the limit actually lives');
  assert.match(message, /THREE WAYS OUT/);
});

test('a broken copy already in the cache is not handed out again', () => {
  // Every row prepared between #253 and this change holds a streamed copy
  // minted against Vercel. Without this the cache would return the refused link
  // forever and the fix would reach no existing row — 185 and 186 included.
  assert.equal(cachedCopyUsable('stream:abc123', 'https://ai-content-dashboard-pi.vercel.app', VERCEL), false);
  assert.equal(cachedCopyUsable('stream:abc123', 'https://media.example', { PUBLIC_MEDIA_BASE_URL: 'https://media.example' }), true);
  // A bucket key or a Drive id is unaffected: those hosts serve files.
  assert.equal(cachedCopyUsable('videos/abc.mp4', 'https://ai-content-dashboard-pi.vercel.app', VERCEL), true);
  assert.equal(cachedCopyUsable('1a2b3c', 'https://ai-content-dashboard-pi.vercel.app', VERCEL), true);
});

// --- IT IS USED WHERE THE COPY IS MADE --------------------------------------

test('the copy maker chooses by size and re-checks what it cached', () => {
  const lib = src('lib/media-library.ts');
  assert.match(lib, /copyRouteFor\(\{/, 'the source must be chosen, not assumed');
  assert.match(lib, /route\.source === 'refuse'/, 'and a host that cannot serve must refuse rather than mint');
  assert.match(lib, /cachedCopyUsable\(known\.id/, 'a cached streamed copy must be re-checked against the host');
  assert.match(lib, /route\.source === 'drive'/, 'the Drive copy is a first choice under the threshold, not only a rescue');
});

// --- THE INSTRUMENT ---------------------------------------------------------
//
// "I've done every test possible, it's not working… check absolutely
//  everything, there's something wrong."
//
// Six rounds of this were diagnosed by reading code, and each cost a send. The
// facts are in the deployment, not the repository — and one of them had never
// been measured by anything: whether a fetcher pulling the WHOLE file gets the
// whole file. A browser plays these links because a player asks for small
// pieces. lib/media-verify.ts passes them because it reads sixteen bytes.
// Metricool pulls the entire video.

test('the check pulls the file the way Metricool does, and says what arrived', () => {
  const route = src('app/api/videos/diagnose/route.ts');
  assert.match(route, /range: 'bytes=0-'/, 'it must ask for a large range, not a probe');
  assert.match(route, /PULL_BYTES = 25 \* 1024 \* 1024/, 'past the size a serverless response is known to cut off at');
  assert.match(route, /THE LINK TRUNCATES/, 'and must say so in words when fewer bytes arrive than were asked for');
  // It reports the four facts that have been argued about all evening.
  for (const fact of ['The video in Drive is', 'Media links are built from', 'Its copy is a', 'A new copy would be']) {
    assert.ok(route.includes(fact), 'the check must report: ' + fact);
  }
  // And it changes nothing.
  assert.ok(!/ensureShareableVideo|rememberPublicCopy|metricoolSchedulePost/.test(route), 'a diagnosis must not make copies or send posts');
});

test('the title is written on arrival, not on a button press', () => {
  const page = src('app/page.tsx');
  const handoff = page.slice(page.indexOf('const handedTitle = workspace.handoffTitle'), page.indexOf('const handedTitle = workspace.handoffTitle') + 1800);
  assert.match(handoff, /looksInternal\(handedTitle/, 'a file name counts as no title at all');
  assert.match(handoff, /'\/api\/title'/, 'and one is written from the draft and the copy');
  assert.ok(
    /if \(!handedTitle \|\| looksInternal/.test(handoff),
    'only when there is nothing usable: a title somebody wrote is never overwritten',
  );
});


test('the refusal quotes the cap this project HAS, not a number from memory', () => {
  // "past the 50 MB storage limit" was written as though 50 MB were a fact
  // about Supabase. It is the FREE PLAN's fixed limit, and
  // lib/video-bucket-key.ts has carried SUPABASE_UPLOAD_MAX_BYTES since it was
  // written — so on a project that had already raised it, the diagnostic named
  // a limit the project did not have and sent the reader to the wrong fix.
  const at = (uploadMaxBytes: number) => {
    const out = copyRouteFor({
      staged: false,
      sizeBytes: 149 * 1024 * 1024,
      base: 'https://ai-content-dashboard-pi.vercel.app',
      env: { VERCEL_PROJECT_PRODUCTION_URL: 'ai-content-dashboard-pi.vercel.app' },
      uploadMaxBytes,
    });
    return out.source === 'refuse' ? out.message : '';
  };
  assert.match(at(50 * 1024 * 1024), /past the 50 MB Supabase upload limit/);
  assert.match(at(120 * 1024 * 1024), /past the 120 MB Supabase upload limit/);
  assert.doesNotMatch(at(120 * 1024 * 1024), /past the 50 MB Supabase/, 'the old hardcoded number is gone');
});

test('the big reels are told the truth about which route survives them', () => {
  // The clinic's reels run to well over a gigabyte (lib/video-bucket-key.ts).
  // Raising the Supabase cap fixes a 149 MB file and cannot fix those: a
  // serverless function will not carry 1.8 GB down from Drive and back up to
  // Supabase. Offering route 1 without saying so would buy one reel and lose
  // the next.
  const out = copyRouteFor({
    staged: false,
    sizeBytes: 1800 * 1024 * 1024,
    base: 'https://ai-content-dashboard-pi.vercel.app',
    env: { VERCEL_PROJECT_PRODUCTION_URL: 'ai-content-dashboard-pi.vercel.app' },
  });
  const message = out.source === 'refuse' ? out.message : '';
  assert.match(message, /1 GB reels/, 'the durable answer must be marked as the durable one');
  assert.match(message, /no\s+serverless function will ever carry/);
});

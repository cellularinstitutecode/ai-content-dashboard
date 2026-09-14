// THE PROMISE THIS PRODUCT MAKES.
//
//   "I'm supposed to have the final publish. Only once I have approved, things
//    can go out — not automatically. The blogs are fine, the Google is fine.
//    Only with the video included; if not, it doesn't go out. And we have the
//    option to publish now."
//
// All four of those were true when this file was written, and they were true
// only because somebody read the code and checked. Nothing asserted them
// together, so a refactor of /api/posts or a new caller in lib/ could break the
// most important guarantee here and the suite would stay green. The failure
// mode is silent and unrecoverable: a post goes out that nobody approved.
//
// These are source checks. Route handlers import `server-only` and cannot run
// under `node --test`, which is exactly why the defects this codebase keeps
// finding live in them — so the same pattern lib/route-policy.test.ts and
// lib/video-required.test.ts use applies here.
//
// Every assertion below carries the sentence explaining what breaking it MEANS,
// so a future failure reads as "you just allowed X to publish without approval"
// rather than as a regex that stopped matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { modeFlags } from './metricool-post.ts';
import { videoVerdict } from './video-required.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const POSTS_ROUTE = 'app/api/posts/route.ts';
const AUTOPILOT = 'lib/autopilot.ts';

// --- 1. ONE SWITCH ----------------------------------------------------------

test('a post only goes live in "scheduled" mode — everything else is a draft', () => {
  // The single fact the other three rules rest on. `autoPublish: true` is what
  // makes Metricool actually post; anything else is a draft sitting in a queue.
  assert.deepEqual(modeFlags('scheduled'), { draft: false, autoPublish: true });
  assert.deepEqual(modeFlags('review'), { draft: true, autoPublish: false });
});

// --- 2. TWO DOORS -----------------------------------------------------------

/**
 * A file's code, with whole-line comments removed.
 *
 * Needed because several files DISCUSS 'scheduled' in prose — lib/metricool.ts
 * and lib/video-publish.ts both explain why they never use it — and a check
 * that counts those is a check that cries wolf until somebody deletes it. Only
 * full-line comments are dropped, so a `https://` inside real code is never
 * mistaken for the start of one.
 */
const code = (p: string) =>
  src(p)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

test('only the approve route and the Autopilot may ask for a live publish', () => {
  // A third file able to send a live post is a third way to publish without a
  // person, and it would be easy to miss in review. Scoped to the files that
  // actually call Metricool's scheduler — lib/post-mode.ts names 'scheduled'
  // too, but it is the pure classifier that DECIDES the mode, not a publisher.
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })) {
      const p = dir + '/' + e.name;
      if (e.isDirectory()) { out.push(...walk(p)); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      if (/metricoolSchedulePost|metricoolReplacePost/.test(src(p))) out.push(p);
    }
    return out;
  };
  const callers = ['lib', 'app/api'].flatMap(walk);
  assert.ok(callers.length >= 4, 'the scheduler callers could not be found — this test needs rewriting');

  const live = callers.filter((p) => p !== 'lib/metricool.ts' && /'scheduled'/.test(code(p))).sort();
  assert.deepEqual(
    live,
    [AUTOPILOT, POSTS_ROUTE].sort(),
    'the set of files that can publish LIVE has changed — every entry must be a door a person opens',
  );
});

test("the Autopilot's live publish is reachable only through an explicit request", () => {
  const body = src(AUTOPILOT);
  assert.match(
    body,
    /opts\.schedule \? 'scheduled' : 'review'/,
    'approveRun no longer defaults to a draft — it could publish on its own',
  );
  // And that flag comes from a signed-in reviewer's request body, nowhere else.
  const route = src('app/api/autopilot/runs/route.ts');
  assert.match(
    route,
    /schedule: body\?\.schedule === true/,
    'the live-publish flag is no longer taken from an authenticated request',
  );
});

// --- 3. NOTHING AUTOMATIC ---------------------------------------------------

test('no daily cron can publish anything', () => {
  // The crons run unattended, on a schedule, with no person watching. If any
  // could reach a live publish, "only once I have approved" would be false.
  for (const cron of ['app/api/autopilot/tick/route.ts', 'app/api/videos/watch/route.ts', 'app/api/maintenance/prune/route.ts']) {
    const body = src(cron);
    for (const forbidden of ['approveRun', 'autoPublish', "'scheduled'"]) {
      assert.ok(
        !body.includes(forbidden),
        cron + ' now references ' + forbidden + ' — an unattended cron must never be able to publish',
      );
    }
  }
});

test('the nightly video sweep hands Metricool a DRAFT', () => {
  // The sweep is the one automatic path that creates posts. It must create them
  // in the review queue, for a person to approve.
  const body = src('lib/video-publish.ts');
  assert.match(body, /\}, 'review'\)/, 'the sweep no longer publishes as a draft');
  assert.ok(
    !/\}, 'scheduled'\)/.test(body),
    'the sweep can now publish live — nothing it creates should bypass approval',
  );
});

// --- 4. PUBLISH NOW IS A FASTER APPROVAL, NOT A BYPASS ----------------------

test('publish_now passes the same gates as approve, before anything goes live', () => {
  // The rule most at risk from a well-meaning refactor: publish_now shares the
  // approve branch, so it inherits both gates. Split it into its own branch and
  // it silently becomes a way to publish a video post with no video.
  const body = src(POSTS_ROUTE);

  const gateAt = body.indexOf('await complianceGate(');
  const videoAt = body.indexOf('videoVerdict(draftPack, videoAttached)');
  const liveAt = body.indexOf("mode = 'scheduled'");
  const nowAt = body.indexOf("action === 'publish_now'");

  assert.ok(gateAt > -1, 'the COFEPRIS gate is gone from the approve path');
  assert.ok(videoAt > -1, 'the video gate is gone from the approve path');
  assert.ok(liveAt > -1, 'the live-publish assignment is gone — this test needs rewriting');
  assert.ok(nowAt > -1, 'publish_now is gone from this route');

  // ORDER, not mere presence. A gate below the assignment is not a gate.
  assert.ok(gateAt < liveAt, 'the advertising gate now runs AFTER the post is made live');
  assert.ok(videoAt < liveAt, 'the video gate now runs AFTER the post is made live');
  // publish_now must sit in the same branch, above both gates — not in a
  // shortcut of its own that reaches the live assignment another way.
  assert.ok(nowAt < gateAt, 'publish_now no longer flows through the gates — it is now a bypass');

  // One live assignment, so there is no second route to it.
  assert.equal(
    body.split("mode = 'scheduled'").length - 1,
    1,
    'there is now more than one way to make a post live in this route',
  );
});

// --- 5. WHAT GOES OUT, AND WHAT DOES NOT ------------------------------------

test('blogs and written posts are unaffected by the video rule', () => {
  // "The blogs are fine, the Google is fine."
  assert.equal(videoVerdict({ blog: 'a written post' }, false).pending, false);
  assert.equal(videoVerdict({ instagram: 'text' }, false).pending, false);
  // A hand-written post has no draft at all.
  assert.equal(videoVerdict(null, false).pending, false);
});

test('a post written from a video does not go out without that video', () => {
  // "Only with the video included; if not, it doesn't go out."
  assert.equal(videoVerdict({ kind: 'video', sourceUrl: 'https://x' }, false).pending, true);
  assert.equal(videoVerdict({ kind: 'clip', video: 'https://y' }, false).pending, true);
  // ...and goes out normally once it has one.
  assert.equal(videoVerdict({ kind: 'video', sourceUrl: 'https://x' }, true).pending, false);
});

// web/lib/autoschedule-wiring.test.ts
//
// Where the floor is actually bolted on. lib/autopilot.ts imports
// `server-only`, so these are source checks — and they matter more here than
// anywhere else in this codebase, because the thing being wired is the removal
// of the person who read every post before it went out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoSchedules } from './autopilot-mode.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('nothing auto-sends unless the setting says so', () => {
  // The default, asserted from two directions: the setting itself, and the
  // fact that the engine asks it before doing anything.
  assert.equal(autoSchedules({}), false);
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /if \(autoSchedules\(\)\) await autoSchedule\(db, run, template\)/);
});

test('the engine approves only at the point where a run is finished', () => {
  // ready_for_review is the one state that means "this post is done". Hooking
  // anywhere earlier would send a half-prepared post.
  const autopilot = src('lib/autopilot.ts');
  const hook = autopilot.slice(autopilot.indexOf("if (run.state === 'ready_for_review') {"));
  assert.ok(hook, 'the hook point is gone — has the loop been rewritten?');
  assert.match(hook.slice(0, 900), /autoSchedules\(\)/);
});

test('the verdict decides, and the reason is written on the card', () => {
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /const verdict = autoScheduleVerdict\(\{/);
  assert.match(autopilot, /citation: compliance\?\.citation\?\.status \?\? null/, 'the Crossref verdict, from the pack stamp');
  assert.match(autopilot, /threshold: SCORE_THRESHOLD/, 'the threshold stays in planner-constants.ts');
  assert.match(autopilot, /safetyFlags: run\.score\?\.safetyFlags\?\.length \?\? 0/);
  assert.match(autopilot, /if \(!verdict\.ok\)/);
  // The write moved into a `hold` helper when the weekly ceiling gave the
  // engine a SECOND reason to hold a run; both go through it, so the two
  // cannot drift into writing the card differently.
  assert.match(autopilot, /await hold\(db, run, holdNote\(verdict\)\)/, 'a held post must say why');
  assert.match(autopilot, /logLine\(run, 'hold', note\)/, 'and the helper really does write it to the card');
  assert.match(
    autopilot,
    /\.eq\('state', 'ready_for_review'\);\n\s*if \(error\) reportError\('autopilot:autoschedule-hold'/,
    'predicated, so a hold note cannot land on a run a reviewer just approved',
  );
});

test('a text-flagged image counts as no image', () => {
  // The ship-point already refuses to attach one, so a post that needs a
  // picture and has only a flagged one has no picture. Counting it would send
  // an Instagram post that Instagram then refuses.
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /image\?\.verification\?\.textDetected !== true/);
});

test('a failure leaves the post in the queue rather than losing it', () => {
  const autopilot = src('lib/autopilot.ts');
  const fn = autopilot.slice(autopilot.indexOf('async function autoSchedule('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /try \{/, 'the whole thing is wrapped');
  assert.match(body, /reportError\('autopilot:autoschedule'/);
  // An unreadable draft holds rather than sending with signals it could not read.
  assert.match(body, /reportError\('autopilot:autoschedule-draft'/);
  assert.match(body, /return;/);
});

test('the comments that promised a human no longer claim one unconditionally', () => {
  // This engine's header said "It NEVER publishes" and ApproveOptions said
  // "the engine never sets this". Both are now conditional, and a comment that
  // quietly became false is worse than no comment.
  const autopilot = src('lib/autopilot.ts');
  assert.doesNotMatch(autopilot, /It NEVER publishes/);
  assert.doesNotMatch(autopilot, /the engine never sets this/);
  assert.match(autopilot, /AUTOPILOT_AUTOSCHEDULE/);
  assert.match(autopilot, /fails CLOSED/);
});

test('the setting is documented where somebody configuring it will read it', () => {
  const env = src('.env.example');
  assert.match(env, /AUTOPILOT_AUTOSCHEDULE/);
  assert.match(env, /off by default/i);
});

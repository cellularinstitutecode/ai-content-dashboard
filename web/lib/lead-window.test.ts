// web/lib/lead-window.test.ts
//
// The floors, and the two constants they are computed from. Those constants
// describe things that live in OTHER files — a cron in vercel.json and a state
// list in the engine — so the tests that assert them are the point of this
// suite. The bug this whole module exists for was a floor that was quietly
// wrong about the cron it was measured against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  minimumLeadHours,
  retryBudgetLeadHours,
  leadProblem,
  retryBudgetProblem,
  usableLeadHours,
  TICK_INTERVAL_MINUTES,
  EXPIRY_GRACE_HOURS,
  STEPS_TO_READY,
} from './lead-window.ts';
import { MAX_ATTEMPTS } from './planner-constants.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('TICK_INTERVAL_MINUTES is the cron in vercel.json, not a number somebody remembered', () => {
  // THE ASSERTION THIS FILE IS FOR. Every floor below is derived from this
  // constant; a cron changed without it puts them all back to being wrong in
  // the direction that silently loses posts.
  const crons = JSON.parse(src('vercel.json')).crons as { path: string; schedule: string }[];
  const tick = crons.find((c) => c.path === '/api/autopilot/tick');
  assert.ok(tick, 'the autopilot tick has no cron at all');
  assert.equal(tick!.schedule, '0 * * * *', 'the tick is meant to be hourly');
  assert.equal(TICK_INTERVAL_MINUTES, 60, 'and this constant must say the same thing');
});

test('STEPS_TO_READY is the engine’s own state list', () => {
  // planned -> researched -> drafted -> ready_for_review. ACTIVE_STATES is a
  // private const in a server-only module, so this is a source check: adding a
  // step without widening the floor is how a lead becomes too short again.
  const autopilot = src('lib/autopilot.ts');
  const line = autopilot.match(/const ACTIVE_STATES = \[(.*?)\] as const;/);
  assert.ok(line, 'ACTIVE_STATES is gone or has changed shape');
  const states = line![1].split(',').filter((s) => s.trim());
  assert.equal(STEPS_TO_READY, states.length, 'the pipeline is ' + states.length + ' steps long now');
});

test('the floors are hours, not most of a day, and no longer depend on the slot', () => {
  // The old floors were 8 hours for a 09:00 Cancún slot and 19 for an evening
  // one, purely to catch a single 06:30 cron. Hourly ticks reach every slot
  // alike, so what is left is the work itself.
  assert.equal(minimumLeadHours(), 3, 'three passes to research, write and score');
  assert.equal(retryBudgetLeadHours(), 3 + MAX_ATTEMPTS, 'plus one pass per attempt');
  assert.ok(retryBudgetLeadHours() > minimumLeadHours(), 'the retry floor must be the higher of the two');
});

test('the default lead of 24 hours clears both floors comfortably', () => {
  assert.equal(leadProblem(24), null);
  assert.equal(retryBudgetProblem(24), null);
});

test('a lead below the floor is refused, and the message names the number to use', () => {
  const p = leadProblem(1);
  assert.ok(p, 'a one-hour lead cannot finish a three-pass pipeline before the slot');
  assert.equal(p!.minimum, minimumLeadHours());
  assert.match(p!.message, /at least 3 hours/);
  assert.match(p!.message, /wakes once an hour/, 'it says WHY: the old failure blamed the slot time');
  assert.match(p!.message, /1 hour\b/, 'singular reads as a sentence, not a template');
});

test('a lead that runs but has no spare pass gets the quieter warning only', () => {
  // The two are deliberately separate: collapsing them would either overstate
  // "this has no second chance" or understate "this cannot be ready in time".
  const lead = minimumLeadHours();
  assert.equal(leadProblem(lead), null, 'at the floor it is not broken');
  const thin = retryBudgetProblem(lead);
  assert.ok(thin, 'but it has nothing left for a failed step');
  assert.equal(thin!.recommended, retryBudgetLeadHours());
  assert.match(thin!.message, /never retried/);

  // And below BOTH floors, both fire — the caller shows only the first.
  assert.ok(leadProblem(1));
  assert.ok(retryBudgetProblem(1));
});

test('a usable lead is raised, never lowered', () => {
  assert.equal(usableLeadHours(1), minimumLeadHours(), 'too short is raised to the floor');
  assert.equal(usableLeadHours(48), 48, 'generous is left alone');
  assert.equal(usableLeadHours(24), 24);
});

test('the minimum really does fit the pipeline in before the slot', () => {
  // The property that matters, walked minute by minute: with this lead, at
  // least STEPS_TO_READY ticks fall strictly BEFORE the slot, whatever minute
  // of the day it sits on. "Before" is the whole point — a post finished at
  // its own slot time is a post that publishes late.
  const lead = minimumLeadHours() * 60;
  for (let slot = 0; slot < 1440; slot++) {
    let ticks = 0;
    // Ticks fire on the hour; walk a full day of them around this slot.
    for (let t = slot - 1440; t < slot; t += 1) {
      if (t % TICK_INTERVAL_MINUTES !== 0) continue;
      if (t >= slot - lead) ticks++;
    }
    assert.ok(ticks >= STEPS_TO_READY, 'slot ' + slot + ' gets only ' + ticks + ' pass(es) before it');
  }
});

test('the retry floor really does add a spare pass per attempt', () => {
  const lead = retryBudgetLeadHours() * 60;
  for (let slot = 0; slot < 1440; slot++) {
    let ticks = 0;
    for (let t = slot - 1440; t < slot; t += 1) {
      if (t % TICK_INTERVAL_MINUTES !== 0) continue;
      if (t >= slot - lead) ticks++;
    }
    assert.ok(ticks >= STEPS_TO_READY + MAX_ATTEMPTS, 'slot ' + slot + ' got only ' + ticks);
  }
});

test('the grace window still outlasts a tick, so nothing expires unseen', () => {
  // expireStaleRuns runs BEFORE advanceRuns in the same request. If the grace
  // were shorter than the gap between ticks, a run could be retired by the very
  // tick that was about to work on it, having never had a pass at all.
  assert.ok(
    EXPIRY_GRACE_HOURS * 60 >= TICK_INTERVAL_MINUTES,
    'a run could be expired by the tick that should have advanced it',
  );
});

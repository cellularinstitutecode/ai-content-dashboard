// web/lib/content-strategy.test.ts
//
// The strategy document, transcribed. These tests are not about logic — there
// is almost none — they are about the transcription staying faithful, because
// every one of these strings ends up in a published medical advertisement.
//
// The one thing worth asserting hardest: a template pinned to ONE day advances
// its seed list once a week (lib/autopilot.ts rotates by occurrence), so the
// angle bank's LENGTH is how many weeks pass before a pillar repeats itself.
// That is the document's core rule — "repeat the pillar, not the wording" —
// expressed as a number, and it is the number that breaks first if somebody
// trims a bank to save a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PILLARS,
  POSTS_PER_WEEK,
  SLOT_TIMES,
  WEEK,
  WEEKLY_MIX,
  daysFor,
  pillarById,
  plannedTemplates,
} from './content-strategy.ts';

test('fourteen posts a week, two a day, seven days', () => {
  assert.equal(WEEK.length, 14);
  assert.equal(POSTS_PER_WEEK, 14);
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    const onThatDay = WEEK.filter((s) => s.day === day);
    assert.equal(onThatDay.length, 2, 'day ' + day + ' must hold exactly two posts');
    assert.deepEqual(onThatDay.map((s) => s.post).sort(), [1, 2], 'a Post 1 and a Post 2');
  }
});

test('the pillar-to-day table matches the document', () => {
  // The document's own frequency table, which is the unambiguous half of it.
  // Monday: diagnosis + personalized protocols. Thursday: prevention + Cancun.
  // Sunday: sleep/stress + recovery in Cancun. And so on.
  assert.deepEqual(daysFor('diagnosis'), [1]);
  assert.deepEqual(daysFor('protocols'), [1]);
  assert.deepEqual(daysFor('nutrition'), [2]);
  assert.deepEqual(daysFor('supplementation'), [2]);
  assert.deepEqual(daysFor('movement'), [3]);
  assert.deepEqual(daysFor('sleep'), [3]);
  assert.deepEqual(daysFor('prevention'), [4]);
  assert.deepEqual(daysFor('cancun'), [4]);
  assert.deepEqual(daysFor('follow-up'), [5]);
  assert.deepEqual(daysFor('recovery'), [5]);
  assert.deepEqual(daysFor('active-living'), [6]);
  assert.deepEqual(daysFor('practical-nutrition'), [6]);
  assert.deepEqual(daysFor('stress'), [0]);
  assert.deepEqual(daysFor('recovery-cancun'), [0]);
});

test('every pillar carries enough angles to keep a month apart', () => {
  // A template occurs once a week, so the bank length IS the repeat interval.
  // Five is the document's shortest bank; anything under it would bring a
  // pillar back to the same angle inside a month.
  for (const p of PILLARS) {
    assert.ok(p.angles.length >= 5, p.id + ' has only ' + p.angles.length + ' angles');
    assert.ok(p.angles.length <= 12, p.id + ' exceeds the 12 the strategy column stores');
    assert.equal(new Set(p.angles).size, p.angles.length, p.id + ' repeats an angle inside its own bank');
    for (const angle of p.angles) {
      assert.ok(angle.trim().length > 12, p.id + ' has a stub angle: ' + JSON.stringify(angle));
    }
  }
});

test('every slot resolves to a pillar, and every pillar is used', () => {
  for (const slot of WEEK) {
    assert.ok(pillarById(slot.pillarId), 'no pillar for ' + slot.pillarId);
  }
  const used = new Set(WEEK.map((s) => s.pillarId));
  for (const p of PILLARS) {
    assert.ok(used.has(p.id), p.id + ' is defined but never scheduled');
  }
});

test('every pillar is named as the document names its post', () => {
  // The names become template names, and the seeder matches on them to update
  // rather than duplicate — so two pillars sharing a name would quietly become
  // one template. Each is the document's own Post heading.
  const names = PILLARS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'two pillars share a name');
  assert.ok(names.includes('Diagnosis and assessment'));
  assert.ok(names.includes('Cancun and health tourism'));
  assert.ok(names.includes('Recovery in Cancun'));
  assert.ok(names.includes('Sleep, stress, and rest'));
});

test('the two standing notes are attached to the pillars they govern', () => {
  // These are the document's only two rules that are not about a day, and they
  // had nowhere to live before this file. Losing them is how a post ends up
  // claiming Cancún beats everywhere else, or turning a recovery post into an
  // advertisement for HBOT.
  const cancun = pillarById('cancun');
  assert.match(cancun?.rule || '', /Never claim that Cancun is categorically better/);
  assert.match(cancun?.rule || '', /air connectivity/i);

  const recovery = pillarById('recovery');
  assert.match(recovery?.rule || '', /INTRODUCED here and never promoted/);
  assert.match(recovery?.rule || '', /HBOT/);
  assert.match(recovery?.rule || '', /do not present any of them as something to buy/i);

  // And nothing else invents one.
  const withRules = PILLARS.filter((p) => p.rule).map((p) => p.id);
  assert.deepEqual(withRules.sort(), ['cancun', 'recovery']);
});

test('the recommended mix and the day map are both recorded, disagreement and all', () => {
  // The document recommends 5 medical / 5 lifestyle / 2 recovery / 2 Cancun,
  // and its own day map does not produce that. Two slots are listed twice in
  // the frequency table (Friday Post 1 under protocols AND follow-up; Sunday
  // Post 2 under recovery AND Cancun), and "5 healthy-lifestyle posts" names
  // five SUBJECTS that the day map spreads over seven slots.
  //
  // Both halves are asserted so that changing either one is a decision someone
  // makes on purpose, not a drift nobody notices.
  assert.deepEqual(WEEKLY_MIX, { medical: 5, lifestyle: 5, recovery: 2, cancun: 2 });
  assert.equal(Object.values(WEEKLY_MIX).reduce((a, b) => a + b, 0), 14);

  const actual: Record<string, number> = { medical: 0, lifestyle: 0, recovery: 0, cancun: 0 };
  for (const slot of WEEK) actual[pillarById(slot.pillarId)!.group] += 1;
  assert.deepEqual(actual, { medical: 4, lifestyle: 7, recovery: 2, cancun: 1 });
  assert.equal(Object.values(actual).reduce((a, b) => a + b, 0), 14, 'every slot is counted once');
  assert.notDeepEqual(actual, WEEKLY_MIX, 'the source disagrees with itself; do not paper over it');
});

// --- WHAT THE ENGINE IS HANDED ----------------------------------------------

test('each slot becomes a one-day template, which is what makes the rotation weekly', () => {
  // THE LOAD-BEARING DETAIL. lib/autopilot.ts advances the seed list by
  // OCCURRENCE, not by week. A seven-day template would advance it daily and
  // the pillars would drift off their days inside a week; a one-day template
  // advances once a week, which is exactly "the same pillar, a new angle".
  const planned = plannedTemplates();
  assert.equal(planned.length, 14);
  for (const t of planned) {
    assert.equal(t.weekdays.length, 1, t.name + ' must be pinned to a single day');
    assert.ok(t.pillars.length >= 5, t.name + ' must hand over its whole angle bank');
  }
  const monday = planned.filter((t) => t.weekdays[0] === 1);
  assert.deepEqual(monday.map((t) => t.time_of_day), [SLOT_TIMES[1], SLOT_TIMES[2]]);
  assert.equal(monday[0].name, 'Diagnosis and assessment');
  assert.match(monday[0].pillars[0], /begins with a thorough evaluation/);
});

test('the slot times stay clear of the video pipeline', () => {
  // The reels publish at 08:00 and 17:00 (lib/video-slot.ts DEFAULT_POST_TIMES).
  // These 14 are additional, by your decision — so they should not land in the
  // same hour and make the calendar unreadable.
  assert.equal(SLOT_TIMES[1], '09:00');
  assert.equal(SLOT_TIMES[2], '18:00');
  for (const t of Object.values(SLOT_TIMES)) {
    assert.ok(!['08:00', '17:00'].includes(t), 'collides with a video slot');
  }
});

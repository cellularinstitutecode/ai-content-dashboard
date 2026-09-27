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
  CANCUN_RULE,
  DAY_THEMES,
  FREQUENCY_PILLARS,
  PILLARS,
  POSTS_PER_WEEK,
  RECOVERY_RULE,
  SLOT_TIMES,
  WEEK,
  WEEKLY_MIX,
  citationPolicyForSlot,
  daysFor,
  frequencyDays,
  frequencyPillarById,
  mixByPillarDays,
  pillarById,
  plannedTemplates,
  rulesForSlot,
  slotContext,
  slotKey,
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

test('each day page\'s angle bank sits on its day', () => {
  // The page-2 day map. Monday: diagnosis + personalized protocols. Thursday:
  // prevention + Cancun. Sunday: sleep/stress + recovery in Cancun. And so on.
  // (The frequency table's two-day rows are asserted separately below.)
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

test('the two standing notes govern every slot counted towards their rows', () => {
  // These are the document's only two rules that are not about a day. They
  // attach to the frequency table's rows, not to one day's post — so Sunday's
  // "Recovery in Cancun", which the table counts under BOTH recovery and
  // Cancun, carries both. It used to carry neither.
  const cancun = frequencyPillarById('cancun');
  assert.match(cancun?.rule || '', /Never claim that Cancun is categorically better/);
  assert.match(cancun?.rule || '', /air connectivity/i);
  const recovery = frequencyPillarById('recovery');
  assert.match(recovery?.rule || '', /INTRODUCED here and never promoted/);
  assert.match(recovery?.rule || '', /HBOT/);
  assert.match(recovery?.rule || '', /do not present any of them as something to buy/i);

  assert.equal(rulesForSlot('thu-2'), CANCUN_RULE);
  assert.equal(rulesForSlot('fri-2'), RECOVERY_RULE);
  assert.match(rulesForSlot('sun-2'), /categorically better/);
  assert.match(rulesForSlot('sun-2'), /INTRODUCED here and never promoted/);
  // And nothing else invents one.
  const withRules = WEEK.map((s) => slotKey(s)).filter((k) => rulesForSlot(k));
  assert.deepEqual(withRules.sort(), ['fri-2', 'sun-2', 'thu-2']);
  assert.ok(rulesForSlot('sun-2').length <= 800, 'both rules fit the stored rule cap');
});

test('the frequency table is data, and the day map reproduces every row of it', () => {
  assert.equal(FREQUENCY_PILLARS.length, 9);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const expected: Record<string, number[]> = {
    'assessment-prevention': [1, 4], protocols: [1, 5], nutrition: [2, 6], supplementation: [2],
    movement: [3, 6], 'sleep-stress': [3, 0], recovery: [5, 0], cancun: [4, 0],
  };
  for (const [id, days] of Object.entries(expected)) {
    assert.deepEqual(frequencyDays(id, ['primary']).sort(), days.slice().sort(), id);
    const row = frequencyPillarById(id)!;
    for (const d of days) assert.match(row.days, new RegExp(dayNames[d]), id + ' names ' + dayNames[d]);
  }
  // "Primarily Friday; also integrated into assessment content".
  assert.deepEqual(frequencyDays('follow-up', ['primary']), [5]);
  assert.deepEqual(frequencyDays('follow-up', ['integrated']), [1]);
  assert.match(frequencyPillarById('follow-up')!.days, /Primarily Friday; also integrated into assessment content/);
});

test('the recommended mix and the day map are both recorded, and the one difference named', () => {
  // The document recommends 5 medical / 5 lifestyle / 2 recovery / 2 Cancun.
  // Counted the frequency table's way (each primary row a slot belongs to),
  // the day map gives exactly that for medical, recovery and Cancun — and 7
  // lifestyle, because "5 healthy-lifestyle posts" names five SUBJECTS that
  // the day map spreads over seven. Both are asserted so changing either is a
  // decision somebody makes on purpose.
  assert.deepEqual(WEEKLY_MIX, { medical: 5, lifestyle: 5, recovery: 2, cancun: 2 });
  assert.equal(Object.values(WEEKLY_MIX).reduce((a, b) => a + b, 0), 14);
  const mix = mixByPillarDays();
  assert.deepEqual(mix, { medical: 5, lifestyle: 7, recovery: 2, cancun: 2 });
  assert.equal(Object.values(mix).reduce((a, b) => a + b, 0), 16, 'sixteen pillar-days over fourteen slots');
  assert.notEqual(mix.lifestyle, WEEKLY_MIX.lifestyle, 'the source disagrees with itself here; do not paper over it');
});

test('every slot knows its day theme and what else it counts as', () => {
  assert.equal(Object.keys(DAY_THEMES).length, 7);
  assert.deepEqual(slotContext('mon-1'), { dayTheme: 'Understand before treating', alsoCovers: [], integrated: ['Patient follow-up'] });
  assert.deepEqual(slotContext('fri-1')!.alsoCovers, ['Personalized protocols', 'Patient follow-up']);
  assert.deepEqual(slotContext('sun-2')!.alsoCovers, ['Recovery and restoration', 'Cancun and health tourism']);
  assert.equal(slotContext('sun-2')!.dayTheme, 'Well-being and the Cancun experience');
  assert.equal(slotContext('mon-blog'), null);
});

test('only the destination slots may go without a citation', () => {
  const relaxed = WEEK.map((s) => slotKey(s)).filter((k) => citationPolicyForSlot(k) === 'if-health-claim');
  assert.deepEqual(relaxed.sort(), ['sun-2', 'thu-2']);
  assert.equal(citationPolicyForSlot('mon-blog'), 'required');
  assert.equal(citationPolicyForSlot('nonsense'), 'required');
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

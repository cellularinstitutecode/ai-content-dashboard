import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimumLeadHours, leadProblem, usableLeadHours, twoTickLeadHours, retryBudgetProblem, TICK_UTC_MINUTES, EXPIRY_GRACE_HOURS } from './lead-window.ts';

/** Cancún is UTC-5, so a local hour is +5 in UTC. */
const cancun = (hour: number) => ((hour + 5) % 24) * 60;

test('the clinic’s morning slot needs more lead than the box’s minimum', () => {
  // 09:00 Cancun = 14:00 UTC; the tick is 06:30 UTC, so the gap is 7.5h.
  assert.equal(minimumLeadHours(cancun(9)), 8);
  // Which means the default of 24 is fine and a typed-in 4 is not.
  assert.equal(leadProblem(24, cancun(9)), null);
  assert.ok(leadProblem(4, cancun(9)));
});

test('an evening slot needs most of a day of lead', () => {
  // 20:00 Cancun = 01:00 UTC the NEXT day: 18.5h after the tick.
  assert.equal(minimumLeadHours(cancun(20)), 19);
  assert.ok(leadProblem(18, cancun(20)), 'even 18 hours is short for an evening slot');
  assert.equal(leadProblem(19, cancun(20)), null);
});

test('a slot just after the tick needs no lead at all', () => {
  assert.equal(minimumLeadHours(TICK_UTC_MINUTES + 30), 1);
  assert.equal(minimumLeadHours(TICK_UTC_MINUTES), 0);
});

test('a slot inside the grace window is still reachable', () => {
  // Up to two hours BEFORE the tick, expireStaleRuns has not retired it yet.
  assert.equal(minimumLeadHours(TICK_UTC_MINUTES - 60), 0);
  assert.equal(minimumLeadHours(TICK_UTC_MINUTES - 120), 0);
});

test('a slot just outside the grace window wraps to the previous day', () => {
  const just = minimumLeadHours(TICK_UTC_MINUTES - 121);
  assert.ok(just > 20, 'it must now be yesterday’s tick that reaches it: ' + just);
  assert.ok(just <= 24);
});

test('the message names the number to use, not just the problem', () => {
  const p = leadProblem(4, cancun(9));
  assert.match(p!.message, /at least 8 hours/);
  assert.match(p!.message, /never fall inside/, 'it says WHY, because the old failure blamed the slot time');
  assert.equal(p!.minimum, 8);
});

test('a usable lead is raised, never lowered', () => {
  assert.equal(usableLeadHours(4, cancun(9)), 8, 'too short is raised to the minimum');
  assert.equal(usableLeadHours(48, cancun(9)), 48, 'generous is left alone');
  assert.equal(usableLeadHours(24, cancun(20)), 24, 'already above the minimum');
});

test('every minute of the day produces a lead that actually works', () => {
  // The property that matters: whatever the slot, the recommended minimum must
  // put the daily tick inside the window.
  for (let slot = 0; slot < 1440; slot += 15) {
    const lead = minimumLeadHours(slot);
    const windowOpens = slot - lead * 60;
    const windowCloses = slot + 120;
    const tickToday = TICK_UTC_MINUTES;
    const tickYesterday = TICK_UTC_MINUTES - 1440;
    const reaches =
      (tickToday >= windowOpens && tickToday <= windowCloses) ||
      (tickYesterday >= windowOpens && tickYesterday <= windowCloses);
    assert.ok(reaches, 'slot ' + slot + ' with lead ' + lead + ' is never reached');
  }
});

// --- the retry budget MAX_ATTEMPTS assumes -----------------------------------
//
// lib/autopilot.ts sets MAX_ATTEMPTS to 2 and justifies it with "an eligibility
// window that is only ever a couple of ticks wide". At the DEFAULT lead of 24h
// that is false, and these tests pin the arithmetic that makes it true.

test('the default 24h lead gives a 15:00 UTC slot only one tick', () => {
  // 09:00 Cancún = 15:00 UTC = 900 minutes. The window opens 24h before, at
  // 15:00 the previous day; the only 06:30 tick inside it is the slot morning.
  const slot = 900;
  const oneTick = minimumLeadHours(slot);
  assert.ok(24 >= oneTick, 'a 24h lead should at least be usable');
  assert.ok(24 < twoTickLeadHours(slot), 'a 24h lead must NOT count as two ticks');
});

test('the two-tick floor is exactly one more day than the one-tick floor', () => {
  for (const slot of [0, 390, 400, 900, 1439]) {
    assert.equal(twoTickLeadHours(slot), minimumLeadHours(slot) + 24, 'slot ' + slot);
  }
});

test('the two-tick floor really does admit a second tick, at every slot', () => {
  // The property that matters: with this lead, two distinct daily ticks fall
  // inside [slot - lead, slot + grace]. Walked in 15-minute steps like the
  // one-tick property test above.
  for (let slot = 0; slot < 1440; slot += 15) {
    const leadMin = twoTickLeadHours(slot) * 60;
    const slotAbs = 10 * 1440 + slot; // day 10, so there is room behind it
    const opens = slotAbs - leadMin;
    const closes = slotAbs + EXPIRY_GRACE_HOURS * 60;
    let ticks = 0;
    for (let day = 0; day <= 14; day++) {
      const tick = day * 1440 + TICK_UTC_MINUTES;
      if (tick >= opens && tick <= closes) ticks++;
    }
    assert.ok(ticks >= 2, 'slot ' + slot + ' got only ' + ticks + ' tick(s) at the two-tick lead');
  }
});

test('retryBudgetProblem warns below the floor and stays quiet at or above it', () => {
  const slot = 900;
  const rec = twoTickLeadHours(slot);
  assert.equal(retryBudgetProblem(rec, slot), null);
  assert.equal(retryBudgetProblem(rec + 12, slot), null);

  const warn = retryBudgetProblem(24, slot);
  assert.ok(warn, 'a 24h lead should warn about the retry budget');
  assert.equal(warn.recommended, rec);
  // It must describe the real consequence, not just name a number.
  assert.match(warn.message, /one daily pass|never retried/i);
});

test('a broken lead and a thin retry budget are reported separately', () => {
  // 1 hour is below BOTH floors. leadProblem owns "this can never run";
  // retryBudgetProblem owns "this has no second chance". Collapsing them into
  // one sentence would overstate the second or understate the first.
  const slot = 900;
  assert.ok(leadProblem(1, slot), 'leadProblem should refuse a 1h lead');
  assert.ok(retryBudgetProblem(1, slot), 'retryBudgetProblem should also flag it');
  // ...and at a lead that runs but has no budget, only the budget one fires.
  assert.equal(leadProblem(24, slot), null);
  assert.ok(retryBudgetProblem(24, slot));
});

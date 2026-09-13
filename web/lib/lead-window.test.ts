import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimumLeadHours, leadProblem, usableLeadHours, TICK_UTC_MINUTES } from './lead-window.ts';

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

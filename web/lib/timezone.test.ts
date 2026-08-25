// Unit tests for the shared scheduling clock. Run with: npm test
//
// Every scheduler in the app (Autopilot planning, template Apply, the
// Metricool handoff) converts wall-clock times through lib/timezone.ts.
// These tests pin the conversion down hard, because the bug this module
// fixed — template times interpreted as server UTC — shipped silently and
// fired 09:00 posts at 4 AM Cancun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULE_TZ,
  wallClockInTz,
  tzOffsetMs,
  zonedTimeToUtc,
  upcomingSlots,
  formatForMetricool,
} from './timezone.ts';

const CANCUN = 'America/Cancun';

test('the default schedule timezone is the clinic, never the server', () => {
  // With no env overrides in the test run this must resolve to Cancun.
  assert.equal(SCHEDULE_TZ, process.env.SCHEDULE_TIMEZONE || process.env.METRICOOL_TIMEZONE || 'America/Cancun');
});

test('09:00 in Cancun is 14:00 UTC — the exact bug that fired posts at 4 AM', () => {
  const t = zonedTimeToUtc(2026, 8, 26, 9, 0, CANCUN);
  assert.equal(t.toISOString(), '2026-08-26T14:00:00.000Z');
});

test('midnight 00:00 stays midnight (no falsy-zero coercion to 9 AM)', () => {
  const t = zonedTimeToUtc(2026, 8, 26, 0, 0, CANCUN);
  assert.equal(wallClockInTz(t, CANCUN).hh, 0);
  assert.equal(t.toISOString(), '2026-08-26T05:00:00.000Z');
});

test('wallClockInTz and zonedTimeToUtc are inverses', () => {
  const t = zonedTimeToUtc(2026, 12, 31, 23, 45, CANCUN);
  const w = wallClockInTz(t, CANCUN);
  assert.deepEqual([w.y, w.m, w.d, w.hh, w.mm], [2026, 12, 31, 23, 45]);
});

test('tzOffsetMs reports Cancun at a constant -5 hours (no DST there)', () => {
  assert.equal(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), CANCUN), -5 * 3600_000);
  assert.equal(tzOffsetMs(new Date('2026-07-15T12:00:00Z'), CANCUN), -5 * 3600_000);
});

test('a DST-observing zone converts correctly on both sides of the switch', () => {
  // US DST 2026 starts Sunday March 8. 09:00 New York is 14:00Z in winter
  // (EST, UTC-5) and 13:00Z in summer (EDT, UTC-4).
  assert.equal(zonedTimeToUtc(2026, 3, 7, 9, 0, 'America/New_York').toISOString(), '2026-03-07T14:00:00.000Z');
  assert.equal(zonedTimeToUtc(2026, 3, 9, 9, 0, 'America/New_York').toISOString(), '2026-03-09T13:00:00.000Z');
});

test('formatForMetricool renders the clinic wall clock with seconds, no Z, no millis', () => {
  const t = new Date('2026-08-26T14:00:00.000Z'); // 09:00 Cancun
  assert.equal(formatForMetricool(t, CANCUN), '2026-08-26T09:00:00');
  assert.doesNotMatch(formatForMetricool(t, CANCUN), /Z|\.\d/);
});

test('upcomingSlots lands every slot at the requested Cancun wall time and weekday', () => {
  const now = new Date('2026-08-24T18:00:00Z'); // Monday Aug 24, 1 PM Cancun
  const slots = upcomingSlots([1, 3], '09:00', 10, CANCUN, now); // Mon + Wed
  assert.ok(slots.length >= 2, 'expected at least Wed + next Mon within 10 days, got ' + slots.length);
  for (const s of slots) {
    const w = wallClockInTz(s, CANCUN);
    assert.equal(w.hh, 9, s.toISOString() + ' is not 09:00 Cancun');
    assert.equal(w.mm, 0);
    assert.ok([1, 3].includes(w.weekday), s.toISOString() + ' fell on weekday ' + w.weekday);
    assert.ok(s.getTime() > now.getTime(), 'slot in the past');
    assert.ok(s.getTime() <= now.getTime() + 10 * 86400_000, 'slot beyond the horizon');
  }
});

test("upcomingSlots skips today's slot when its time has already passed", () => {
  const now = new Date('2026-08-24T18:00:00Z'); // Monday, 13:00 Cancun — 09:00 already gone
  const slots = upcomingSlots([1], '09:00', 10, CANCUN, now);
  assert.equal(slots.length, 1, 'only next Monday should qualify');
  assert.equal(slots[0].toISOString(), '2026-08-31T14:00:00.000Z');
});

test("upcomingSlots includes today's slot when it is still ahead", () => {
  const now = new Date('2026-08-24T12:00:00Z'); // Monday, 07:00 Cancun — 09:00 still coming
  const slots = upcomingSlots([1], '09:00', 10, CANCUN, now);
  assert.equal(slots[0].toISOString(), '2026-08-24T14:00:00.000Z');
});

test('upcomingSlots output is sorted, unique, and ignores junk weekdays', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const slots = upcomingSlots([5, 1, 1, 3], '10:30', 14, CANCUN, now);
  const times = slots.map((s) => s.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'not sorted');
  assert.equal(new Set(times).size, times.length, 'duplicate slots');
  assert.deepEqual(upcomingSlots([7, -1, NaN as unknown as number], '09:00', 10, CANCUN, now), []);
  assert.deepEqual(upcomingSlots([], '09:00', 10, CANCUN, now), []);
});

test('upcomingSlots survives a malformed time string with a sane default', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const slots = upcomingSlots([2], 'garbage', 10, CANCUN, now);
  assert.ok(slots.length > 0);
  assert.equal(wallClockInTz(slots[0], CANCUN).hh, 9);
});

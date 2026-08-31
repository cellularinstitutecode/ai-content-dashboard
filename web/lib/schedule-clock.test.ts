import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTzLabel, schedulePresetValue, DEFAULT_SCHEDULE_TZ } from './schedule-clock.ts';

test('the timezone label is a city, not an IANA path', () => {
  assert.equal(scheduleTzLabel('America/Cancun'), 'Cancun');
  assert.equal(scheduleTzLabel('America/Mexico_City'), 'Mexico City');
  assert.equal(scheduleTzLabel('UTC'), 'UTC');
});

test('the default zone is the one lib/timezone.ts falls back to', () => {
  assert.equal(DEFAULT_SCHEDULE_TZ, 'America/Cancun');
});

test('a "tomorrow" preset rolls the day on the schedule clock, not the browser', () => {
  // 02:00 UTC on Sep 2 is still 21:00 on Sep 1 in Cancun (UTC-5). "Tomorrow"
  // therefore means Sep 2 there, while a UTC/browser clock would say Sep 3 —
  // the late-evening off-by-one-day this helper exists to prevent.
  const lateEvening = new Date('2026-09-02T02:00:00Z');
  assert.equal(schedulePresetValue(1, 9, lateEvening), '2026-09-02T09:00');
});

test('a preset keeps the hour it was labelled with', () => {
  const noon = new Date('2026-09-01T17:00:00Z');
  assert.equal(schedulePresetValue(0, 18, noon), '2026-09-01T18:00');
  assert.equal(schedulePresetValue(2, 12, noon), '2026-09-03T12:00');
});

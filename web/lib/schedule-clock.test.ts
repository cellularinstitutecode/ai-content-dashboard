import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { scheduleTzLabel, schedulePresetValue, DEFAULT_SCHEDULE_TZ, scheduleInputValue, scheduleInstantFromInput } from './schedule-clock.ts';

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

test('a box value is read on the schedule clock, and an instant is shown on it', () => {
  // 09:00 Cancun (UTC-5) is 14:00 UTC.
  assert.equal(scheduleInstantFromInput('2026-09-16T09:00'), '2026-09-16T14:00:00.000Z');
  assert.equal(scheduleInputValue('2026-09-16T14:00:00.000Z'), '2026-09-16T09:00');
  assert.equal(scheduleInstantFromInput(''), null);
  assert.equal(scheduleInstantFromInput('not a date'), null);
});

test('the Reschedule box round-trips through the schedule clock, whatever the browser zone', () => {
  const iso = scheduleInstantFromInput('2026-10-02T09:30');
  assert.ok(iso, 'a valid value names an instant');
  assert.equal(scheduleInputValue(iso), '2026-10-02T09:30', 'read back on the same clock');
  // Cancun is UTC-5 with no DST: 09:30 there is 14:30Z.
  assert.equal(iso, '2026-10-02T14:30:00.000Z');
});

test('Reschedule is on every post row and in the preview, and sends the instant exactly as a drag does', () => {
  const page = readFileSync(new URL('../app/calendar/page.tsx', import.meta.url), 'utf8');
  assert.equal((page.match(/onClick=\{\(\) => openReschedule\(/g) || []).length, 3, 'past-due rows, upcoming rows, the preview');
  assert.match(page, /type="datetime-local"/);
  assert.match(page, /const iso = scheduleInstantFromInput\(rescheduleFor\.value\);/);
  assert.match(page, /await rescheduleTo\(id, iso\);/);
  assert.match(page, /New date and time · \{scheduleTzLabel\(\)\}/, 'the clinic\'s clock, named');
});

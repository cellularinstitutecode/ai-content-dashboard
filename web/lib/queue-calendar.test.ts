// The dashboard's publishing queue as a month, with the list's buttons on the picked day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cursorOf, defaultDay, gridKey, groupByDay, monthGrid, shiftMonth } from './queue-calendar.ts';

test('the month is six weeks from the Sunday on or before the 1st, as on the calendar page', () => {
  const g = monthGrid({ year: 2026, month: 8 }); // September 2026: the 1st is a Tuesday
  assert.equal(g.length, 42);
  assert.equal(gridKey(g[0]), '2026-08-30');
  assert.equal(g[0].getDay(), 0);
  assert.equal(gridKey(g[2]), '2026-09-01');
  assert.equal(gridKey(g[41]), '2026-10-10');
});

test('months move across a year boundary', () => {
  assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
  assert.deepEqual(cursorOf('2026-10-09'), { year: 2026, month: 9 });
  assert.equal(cursorOf(''), null);
});

test('posts group by day, in time order; undated ones are left out', () => {
  const posts = [
    { id: 'b', day: '2026-09-29', t: 18 },
    { id: 'a', day: '2026-09-29', t: 9 },
    { id: 'c', day: '2026-10-09', t: 13 },
    { id: 'x', day: '', t: 0 },
  ];
  const m = groupByDay(posts, (p) => p.day, (p) => p.t);
  assert.deepEqual(m.get('2026-09-29')?.map((p) => p.id), ['a', 'b']);
  assert.equal(m.size, 2);
});

test('it opens on today, else the next day with a post, else the last one', () => {
  assert.equal(defaultDay(['2026-09-29', '2026-10-09'], '2026-09-29'), '2026-09-29');
  assert.equal(defaultDay(['2026-09-20', '2026-10-09', '2026-10-12'], '2026-09-29'), '2026-10-09');
  assert.equal(defaultDay(['2026-09-20'], '2026-09-29'), '2026-09-20');
  assert.equal(defaultDay([], '2026-09-29'), '2026-09-29');
});

test('the dashboard queue is the month, and keeps every button the list had', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /<QueueCalendar\n/);
  assert.match(page, /const listPosts: any\[\] = queueSearching \? shownPosts : \(queueByDay\.get\(activeQueueDay\) \?\? \[\]\)/);
  assert.match(page, /\{listPosts\.map\(\(p: any, i: number\) =>/);
  for (const label of ['>Preview<', "'Approve'", '>Publish now<', '>Continue<', "'Pick a time' : 'Reschedule'", '>Delete<', 'Select several…']) {
    assert.ok(page.includes(label), 'still there: ' + label);
  }
  assert.doesNotMatch(page, /showAllQueue/, 'the six-row cap is gone: a day shows all of its posts');
  // Days are the schedule's wall-clock days, as on the calendar page.
  assert.match(page, /groupByDay\(safePosts as any\[\], \(p: any\) => scheduleDateKey\(p\?\.publication_date\)/);
  const cal = readFileSync(new URL('../components/QueueCalendar.tsx', import.meta.url), 'utf8');
  assert.match(cal, /onApprove\(p\)/);
  assert.match(cal, /onPreview\(id\)/);
});

test('a post whose time has passed offers Reschedule where Approve would be, and the move is to the next free slot', () => {
  // Metricool refuses a past date, so Approve on such a post could only fail.
  // The button reads Reschedule instead and the server picks the slot
  // (lib/queue-next-slot.ts): the post is moved, not approved.
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /function slotPassed\(p: any\): boolean/);
  assert.match(page, /slotPassed\(p\) \? \(\n<button[^\n]*onClick=\{\(\) => rescheduleNext\(p\)\}[^\n]*'Reschedule'/, 'the list row');
  assert.match(page, /slotPassed\(pp\) \? \(\n\s*<button[^\n]*rescheduleNext\(pp\)[^\n]*'Reschedule'/, 'the preview');
  assert.match(page, /onReschedule=\{\(p: any\) => rescheduleNext\(p\)\}/, 'the month grid');
  assert.match(page, /action: 'reschedule', publication_date: 'next'/);
  const cal = readFileSync(new URL('../components/QueueCalendar.tsx', import.meta.url), 'utf8');
  assert.match(cal, /slotPassed\(p\) \? \(/);
  assert.match(cal, /onReschedule\(p\)/);
  assert.match(cal, /'Reschedule'/);
  const calendar = readFileSync(new URL('../app/calendar/page.tsx', import.meta.url), 'utf8');
  assert.match(calendar, /waiting && overdueIds\.includes\(String\(p\.id\)\) \? \(\n\s*<button[^\n]*rescheduleNext\(p\)/, 'the day list');
  assert.match(calendar, /overdueIds\.includes\(String\(previewPost\.id\)\) \? \(\n\s*<button[^\n]*rescheduleNext\(previewPost\)/, 'the preview');
  assert.doesNotMatch(calendar, /Move to tomorrow/, 'the overdue list moves to the next free slot too');
  const route = readFileSync(new URL('../app/api/posts/route.ts', import.meta.url), 'utf8');
  assert.match(route, /if \(publicationDate === NEXT_SLOT\) \{\n[^]*?nextFreeSlotFor\(sb, user\.id, id\)/);
  assert.match(route, /error: 'date_passed', message: 'That date has already passed\. Press Reschedule/);
});

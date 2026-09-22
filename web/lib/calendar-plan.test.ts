import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyPlanByDay, overduePosts } from './calendar-plan.ts';

test('active templates land on their weekdays, sorted by time; paused ones do not', () => {
  const plan = weeklyPlanByDay([
    { name: 'Sleep', weekdays: [3], time_of_day: '18:00:00', active: true, strategy: { seeded: 'weekly-strategy' } },
    { name: 'Movement', weekdays: [3], time_of_day: '09:00', active: true, strategy: { seeded: 'weekly-strategy' } },
    { name: 'Old', weekdays: [3], time_of_day: '12:00', active: false },
    { name: 'Mine', weekdays: [1, 3], time_of_day: '10:00', active: true },
  ]);
  assert.deepEqual(plan[3].map((e) => e.name), ['Movement', 'Mine', 'Sleep']);
  assert.equal(plan[3][2].time, '18:00');
  assert.equal(plan[3][0].fromStrategy, true);
  assert.equal(plan[3][1].fromStrategy, false);
  assert.deepEqual(plan[1].map((e) => e.name), ['Mine']);
});

test('overdue = still waiting and past its time', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  const posts = [
    { id: 'a', publication_date: '2026-09-19T15:00:00Z', status: 'waiting' },
    { id: 'b', publication_date: '2026-09-19T14:00:00Z', status: 'published' },
    { id: 'c', publication_date: '2026-09-22T14:00:00Z', status: 'waiting' },
  ];
  const out = overduePosts(posts, (s) => s === 'waiting', now);
  assert.deepEqual(out.map((p) => p.id), ['a']);
});

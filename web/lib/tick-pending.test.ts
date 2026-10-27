// Unit tests for which sheet ticks are still waiting for a time. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingTicks } from './tick-pending.ts';

const line = (videoKey: string, event: string, createdAt: string, detail: Record<string, unknown> = {}) => ({ videoKey, event, createdAt, detail });

test('a ticked row is pending until a queued line for the same video comes after it', () => {
  const rows = [
    line('s|t|a', 'ticked', '2026-10-27T21:39:00Z', { tab: 't', row: 224, owed: ['facebook', 'instagram'] }),
    line('s|t|b', 'ticked', '2026-10-27T21:40:00Z', { tab: 't', row: 225, owed: ['youtube'] }),
    line('s|t|b', 'queued', '2026-10-27T21:45:00Z', { tab: 't', row: 225 }),
  ];
  const out = pendingTicks(rows);
  assert.deepEqual(out.map((p) => p.row), [224]);
  assert.deepEqual(out[0].owed, ['facebook', 'instagram']);
  assert.equal(out[0].tab, 't');
});

test('a tick after the queued line reopens the row; the newest tick wins and the list is newest first', () => {
  const rows = [
    line('s|t|b', 'queued', '2026-10-27T10:00:00Z', { tab: 't', row: 225 }),
    line('s|t|b', 'ticked', '2026-10-27T11:00:00Z', { tab: 't', row: 225, owed: ['x'] }),
    line('s|t|a', 'ticked', '2026-10-27T09:00:00Z', { tab: 't', row: 224, owed: ['facebook'] }),
    line('s|t|a', 'ticked', '2026-10-27T12:00:00Z', { tab: 't', row: 224, owed: [] }),
  ];
  const out = pendingTicks(rows);
  assert.deepEqual(out.map((p) => [p.row, p.at]), [[224, '2026-10-27T12:00:00Z'], [225, '2026-10-27T11:00:00Z']]);
  assert.deepEqual(out[0].owed, [], 'the newest tick for a row is the one kept');
});

test('lines without a row, and events of other kinds, are ignored', () => {
  assert.deepEqual(pendingTicks([line('s|t|a', 'ticked', '2026-10-27T09:00:00Z', {}), line('s|t|a', 'prepared', '2026-10-27T09:30:00Z', { row: 1 })]), []);
});

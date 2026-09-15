import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belowStart, parseQuota, parseStartRow, remainingQuota, startOfDayIso } from './daily-pace.ts';

test('the start row is read bare or with a tab', () => {
  assert.deepEqual(parseStartRow('179'), { tab: null, row: 179 });
  assert.deepEqual(parseStartRow(' 179 '), { tab: null, row: 179 });
  assert.deepEqual(parseStartRow('Marzo!179'), { tab: 'Marzo', row: 179 });
  assert.deepEqual(parseStartRow("'Videos 2026'!12"), { tab: 'Videos 2026', row: 12 });
  for (const bad of ['', null, undefined, 'abc', '0', '1', '-5', '12.5', 'Marzo!', 'Marzo!x']) {
    assert.equal(parseStartRow(bad), null, JSON.stringify(bad));
  }
});

test('rows below the start are not the sweep’s to prepare; rows at or after it are', () => {
  const every = parseStartRow('179');
  assert.equal(belowStart('Marzo', 178, every), true);
  assert.equal(belowStart('Marzo', 179, every), false);
  assert.equal(belowStart('Abril', 3, every), true);
  const one = parseStartRow('Marzo!179');
  assert.equal(belowStart('Marzo', 178, one), true);
  assert.equal(belowStart('marzo ', 178, one), true);
  // Another tab is not restricted by a start row that names Marzo.
  assert.equal(belowStart('Abril', 3, one), false);
  assert.equal(belowStart('Marzo', 5, null), false);
});

test('the daily quota is a whole number of rows, or no rule', () => {
  assert.equal(parseQuota('2'), 2);
  assert.equal(parseQuota(' 10 '), 10);
  for (const bad of ['', '0', '-1', 'two', '1.5', null, undefined]) assert.equal(parseQuota(bad), null, JSON.stringify(bad));
});

test('what is left of the day counts what was already prepared today', () => {
  assert.equal(remainingQuota(2, 0), 2);
  assert.equal(remainingQuota(2, 1), 1);
  assert.equal(remainingQuota(2, 2), 0);
  assert.equal(remainingQuota(2, 7), 0);
  assert.equal(remainingQuota(2, NaN), 2);
  assert.equal(remainingQuota(null, 5), null);
});

test('today starts at midnight on the clinic’s clock, not the server’s', () => {
  // 07:00 UTC is 02:00 in Cancún: still the same Cancún day, which began at 05:00 UTC.
  assert.equal(startOfDayIso(new Date('2026-09-16T07:00:00Z'), 'America/Cancun'), '2026-09-16T05:00:00.000Z');
  // 03:00 UTC is 22:00 the previous evening in Cancún.
  assert.equal(startOfDayIso(new Date('2026-09-16T03:00:00Z'), 'America/Cancun'), '2026-09-15T05:00:00.000Z');
  assert.equal(startOfDayIso(new Date('2026-09-16T12:34:56.789Z'), 'UTC'), '2026-09-16T00:00:00.000Z');
});

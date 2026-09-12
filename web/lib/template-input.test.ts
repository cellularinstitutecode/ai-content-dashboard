import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWeekdays, cleanTime, isUsableTime } from './template-input.ts';

test('weekdays are deduplicated and ordered', () => {
  assert.deepEqual(cleanWeekdays([3, 1, 1, 5]), [1, 3, 5]);
});

test('out-of-range and nonsense entries are dropped, not fatal', () => {
  assert.deepEqual(cleanWeekdays([0, 7, -1, 'x', null, 6.5, 6]), [0, 6]);
  assert.deepEqual(cleanWeekdays('monday'), []);
  assert.deepEqual(cleanWeekdays(undefined), []);
});

test('numeric strings are accepted — a model sends "1" as readily as 1', () => {
  assert.deepEqual(cleanWeekdays(['1', '2']), [1, 2]);
});

test('a valid 24-hour time survives untouched', () => {
  assert.equal(cleanTime('00:00'), '00:00');
  assert.equal(cleanTime('23:59'), '23:59');
  assert.equal(cleanTime('13:05'), '13:05');
});

test('anything else becomes 09:00, and is reported as not understood', () => {
  for (const bad of ['9am', '24:00', '13:60', '1:05', '', null, undefined, '13:5']) {
    assert.equal(cleanTime(bad), '09:00', String(bad));
    assert.equal(isUsableTime(bad), false, String(bad));
  }
  assert.equal(isUsableTime('08:00'), true);
});

// The reason the whole file exists: three blogs a day is three templates at
// three times, so a time that quietly collapses to the default merges two of
// them onto the same slot.
test('distinct times stay distinct', () => {
  const times = ['08:00', '13:00', '18:00'].map(cleanTime);
  assert.equal(new Set(times).size, 3);
});

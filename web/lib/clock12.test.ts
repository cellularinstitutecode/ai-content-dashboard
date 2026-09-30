import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtClock12 } from './clock12.ts';

test('fmtClock12: the stored HH:MM as a 12-hour clock', () => {
  assert.equal(fmtClock12('09:00'), '9:00 AM');
  assert.equal(fmtClock12('13:30'), '1:30 PM');
  assert.equal(fmtClock12('00:00'), '12:00 AM');
  assert.equal(fmtClock12('12:00'), '12:00 PM');
  assert.equal(fmtClock12('23:59'), '11:59 PM');
  assert.equal(fmtClock12('9:05'), '9:05 AM');
  assert.equal(fmtClock12('18:00:00'), '6:00 PM');
});

test('fmtClock12: compact drops :00 for a calendar chip', () => {
  assert.equal(fmtClock12('09:00', { compact: true }), '9 AM');
  assert.equal(fmtClock12('17:30', { compact: true }), '5:30 PM');
});

test('fmtClock12: anything that is not a clock time is left as it was', () => {
  assert.equal(fmtClock12(''), '');
  assert.equal(fmtClock12(undefined), '');
  assert.equal(fmtClock12('—'), '—');
  assert.equal(fmtClock12('25:00'), '25:00');
  assert.equal(fmtClock12('09:75'), '09:75');
});

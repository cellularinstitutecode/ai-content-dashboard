import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFromRow, rowsBetween, rowsFrom, type RowLike } from './rows-from.ts';

const L = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view';
const rows: RowLike[] = [
  { tab: 'Marzo', row: 178, link: L, copy: '' },
  { tab: 'Marzo', row: 179, link: L, copy: '' },
  { tab: 'Marzo', row: 180, link: L, copy: 'already written' },
  { tab: 'Marzo', row: 181, link: '', copy: '' },
  { tab: 'Marzo', row: 183, link: L, copy: '' },
  { tab: 'Marzo', row: 182, link: L, copy: '' },
  { tab: 'Abril', row: 200, link: L, copy: '' },
];

test('"from row" is a whole number of at least 2', () => {
  assert.equal(parseFromRow('179'), 179);
  assert.equal(parseFromRow(' 179 '), 179);
  assert.equal(parseFromRow(2), 2);
  for (const bad of ['', '0', '1', '-4', 'abc', '12.5', null, undefined]) assert.equal(parseFromRow(bad), null, JSON.stringify(bad));
});

test('from 179 on one tab: the rows that are work, in row order, nothing above', () => {
  assert.deepEqual(rowsFrom(rows, 179, 'Marzo'), ['Marzo:179', 'Marzo:182', 'Marzo:183']);
});

test('a row with copy, or without a video, is never selected', () => {
  const keys = rowsFrom(rows, 179, 'Marzo');
  assert.ok(!keys.includes('Marzo:180'), 'row 180 already has copy');
  assert.ok(!keys.includes('Marzo:181'), 'row 181 has no video');
});

test('without a tab the rule applies to every tab; the tab match ignores case', () => {
  assert.deepEqual(rowsFrom(rows, 179), ['Abril:200', 'Marzo:179', 'Marzo:182', 'Marzo:183']);
  assert.deepEqual(rowsFrom(rows, 179, 'marzo '), ['Marzo:179', 'Marzo:182', 'Marzo:183']);
});

test('no row means no selection', () => {
  assert.deepEqual(rowsFrom(rows, null, 'Marzo'), []);
  assert.deepEqual(rowsFrom([], 179, 'Marzo'), []);
  assert.deepEqual(rowsFrom(rows, 999, 'Marzo'), []);
});

test('a From–To range takes every row with a video, copy or not, inclusive at both ends', () => {
  assert.deepEqual(rowsBetween(rows, 179, 182, 'Marzo'), ['Marzo:179', 'Marzo:180', 'Marzo:182']);
  // Row 180 has copy and is included; row 181 has no video and is not.
  assert.deepEqual(rowsBetween(rows, 178, 181, 'Marzo'), ['Marzo:178', 'Marzo:179', 'Marzo:180']);
});

test('an empty To means to the end; To before From means nothing', () => {
  assert.deepEqual(rowsBetween(rows, 182, null, 'Marzo'), ['Marzo:182', 'Marzo:183']);
  assert.deepEqual(rowsBetween(rows, 183, 179, 'Marzo'), []);
  assert.deepEqual(rowsBetween(rows, null, 190, 'Marzo'), []);
  assert.deepEqual(rowsBetween(rows, 179, 179, 'Marzo'), ['Marzo:179']);
});

test('the "needs copy" selection also honours a To row when one is given', () => {
  assert.deepEqual(rowsFrom(rows, 179, 'Marzo', 182), ['Marzo:179', 'Marzo:182']);
  assert.deepEqual(rowsFrom(rows, 179, 'Marzo', 178), []);
  assert.deepEqual(rowsFrom(rows, 179, 'Marzo', null), ['Marzo:179', 'Marzo:182', 'Marzo:183']);
});

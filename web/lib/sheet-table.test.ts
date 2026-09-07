// The two planning sheets are edited by hand, in two languages, with header
// rows that are not on row 1. These pin the reading rules against rows shaped
// like the real documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableFromRows, parseSheetDate, pick } from './sheet-table.ts';

test('the header row is found by content, and rows become records keyed by header', () => {
  const rows = [
    ['Cellular Institute Content Calendar'],
    [],
    ['Number of Posts', 'Date', 'Type of Post', 'Caption', 'File Name', 'Graphics Link', 'Status', 'IG', 'FB'],
    ['', 'May 13, 2026', 'DESIGN ', 'Many times, the body starts showing signals…', 'POST JUNIO— 1.jpg', 'https://drive.google.com/file/d/abc/view', 'POSTED', 'x', ''],
    ['', '', '', '', '', '', '', '', ''],
  ];
  const { header, records } = tableFromRows(rows, ['date', 'caption', 'status', 'type of post']);
  assert.equal(header[1], 'date');
  assert.equal(records.length, 1);
  assert.equal(pick(records[0], 'caption'), 'Many times, the body starts showing signals…');
  assert.equal(pick(records[0], 'type of post', 'type'), 'DESIGN');
  assert.equal(pick(records[0], 'ig'), 'x');
  assert.equal(pick(records[0], 'fb'), '');
});

test("Rodrigo's sheet: Spanish headers with accents, and an unnamed first column", () => {
  const rows = [
    [' ', 'FECHA DE ELABORACIÓN', 'TIPO DE VIDEO', 'TÍTULO DEL VIDEO', 'COPY', 'LINK VIDEO', 'FORMATO', 'YOUTUBE', 'LINKEDIN'],
    ['Rodrigo', 'Feb.', 'Your Journey Begins Here', 'How Our Medical Evaluation Process Works', '', 'https://drive.google.com/file/d/1FX/view', 'Horizontal 16:9', 'Unlisted', ''],
  ];
  const { header, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'copy', 'link video', 'formato']);
  assert.equal(header[0], 'col0');
  assert.equal(records[0].col0, 'Rodrigo');
  assert.equal(records.length, 1);
  assert.equal(pick(records[0], 'título del video', 'title'), 'How Our Medical Evaluation Process Works');
  assert.equal(pick(records[0], 'link video'), 'https://drive.google.com/file/d/1FX/view');
  assert.equal(pick(records[0], 'youtube'), 'Unlisted');
});

test('no recognisable header means no records, not garbage', () => {
  const { header, records } = tableFromRows([['Sun', 'Mon', 'Tue'], ['1', '2', '3']], ['date', 'caption', 'status']);
  assert.deepEqual(header, []);
  assert.deepEqual(records, []);
});

test('dates in the forms people type; bare grid numbers are not dates', () => {
  assert.equal(parseSheetDate('May 13, 2026'), '2026-05-13');
  assert.equal(parseSheetDate('13/05/2026'), '2026-05-13');
  assert.equal(parseSheetDate('2026-09-08'), '2026-09-08');
  assert.equal(parseSheetDate('13'), null);
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate('Not started'), null);
});

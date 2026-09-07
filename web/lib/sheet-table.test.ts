// The two planning sheets are edited by hand, in two languages, with header
// rows that are not on row 1. These pin the reading rules against rows shaped
// like the real documents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableFromRows, parseSheetDate, pick, columnFor, columnLetter } from './sheet-table.ts';

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
  assert.equal(pick(records[0].rec, 'caption'), 'Many times, the body starts showing signals…');
  assert.equal(pick(records[0].rec, 'type of post', 'type'), 'DESIGN');
  assert.equal(pick(records[0].rec, 'ig'), 'x');
  assert.equal(pick(records[0].rec, 'fb'), '');
});

test("Rodrigo's sheet: Spanish headers with accents, and an unnamed first column", () => {
  const rows = [
    [' ', 'FECHA DE ELABORACIÓN', 'TIPO DE VIDEO', 'TÍTULO DEL VIDEO', 'COPY', 'LINK VIDEO', 'FORMATO', 'YOUTUBE', 'LINKEDIN'],
    ['Rodrigo', 'Feb.', 'Your Journey Begins Here', 'How Our Medical Evaluation Process Works', '', 'https://drive.google.com/file/d/1FX/view', 'Horizontal 16:9', 'Unlisted', ''],
  ];
  const { header, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'copy', 'link video', 'formato']);
  assert.equal(header[0], 'col0');
  assert.equal(records[0].rec.col0, 'Rodrigo');
  assert.equal(records.length, 1);
  assert.equal(pick(records[0].rec, 'título del video', 'title'), 'How Our Medical Evaluation Process Works');
  assert.equal(pick(records[0].rec, 'link video'), 'https://drive.google.com/file/d/1FX/view');
  assert.equal(pick(records[0].rec, 'youtube'), 'Unlisted');
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

test('a record knows which row it came from, so it can be written back', () => {
  // Without this a value read out of a sheet can never be edited: an update
  // needs "'September 2026'!M7" and the row is the half that is otherwise lost.
  const rows = [
    ['Cellular Institute Social Media Calendar', '', '', ''],
    [],
    ['Sun', 'Mon', 'Tue', '', 'ID', 'Date', 'Pillar', 'Type', 'Description', 'Owner', 'Status', 'CTA'],
    ['', '', '1', '', '1', '2026-09-10', 'Education', 'Reel', 'Exosome therapy explained', 'Meriz', 'For approval', 'Book a call'],
    ['2', '3', '4', '', '2', '2026-09-17', 'Proof', 'Carousel', 'Meet the team', 'Meriz', 'Not started', ''],
  ];
  const t = tableFromRows(rows, ['date', 'description', 'status', 'owner', 'pillar']);
  assert.equal(t.headerRow, 3, 'the header is the third row');
  assert.equal(t.records.length, 2);
  assert.equal(t.records[0].row, 4, 'first data row is row 4, counting from 1');
  assert.equal(t.records[1].row, 5);
  assert.equal(pick(t.records[0].rec, 'description'), 'Exosome therapy explained');
});

test('a field maps to the A1 column it actually occupies', () => {
  // The month grid (Sun/Mon/Tue) sits to the LEFT of the task table on every
  // tab, so the data columns do not start at A. Getting this wrong writes into
  // Meriz's calendar squares.
  const header = ['sun', 'mon', 'tue', 'col3', 'id', 'date', 'pillar', 'type', 'description', 'owner', 'status', 'cta'];
  assert.equal(columnFor(header, 'description'), 'I');
  assert.equal(columnFor(header, 'date'), 'F');
  assert.equal(columnFor(header, 'status'), 'K');
  assert.equal(columnFor(header, 'nothing like this'), null);
});

test('column letters carry past Z, where a wide sheet lives', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(51), 'AZ');
  assert.equal(columnLetter(52), 'BA');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellText, gridText } from './sheet-cells.ts';
import { firstLinkIn, isCandidate } from './video-row.ts';

const DRIVE = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing';

test('a plain cell reads exactly as the values API returned it', () => {
  assert.equal(cellText({ formattedValue: 'Reel_Shoulder2Ryall_Rodrigo' }), 'Reel_Shoulder2Ryall_Rodrigo');
  assert.equal(cellText({ formattedValue: DRIVE }), DRIVE);
  assert.equal(cellText({}), '');
  assert.equal(cellText(null), '');
  assert.equal(cellText(undefined), '');
});

test('a whole-cell link is appended, and the sweep then sees the video', () => {
  const text = cellText({ formattedValue: 'Testimonio Lance_sub.mp4', hyperlink: DRIVE });
  assert.equal(text, 'Testimonio Lance_sub.mp4 ' + DRIVE);
  assert.equal(firstLinkIn(text), DRIVE.replace(/[),.]+$/, ''));
  assert.equal(isCandidate({ videoLink: text, copy: '' }), true);
});

test('a link on part of the text counts too', () => {
  const text = cellText({
    formattedValue: 'CASEY TESTIMONY SUBS.mp4',
    textFormatRuns: [{ format: {} }, { format: { link: { uri: DRIVE } } }],
  });
  assert.equal(firstLinkIn(text), DRIVE);
});

test('a cell that already shows a URL is not given a second one', () => {
  const shown = 'SUBS: ' + DRIVE;
  assert.equal(cellText({ formattedValue: shown, hyperlink: DRIVE }), shown);
});

test('a link that is not a URL is ignored', () => {
  assert.equal(cellText({ formattedValue: 'x', hyperlink: 'mailto:a@b.c' }), 'x');
  assert.equal(cellText({ formattedValue: 'x', textFormatRuns: [{ format: { link: { uri: '#gid=0' } } }] }), 'x');
  // An empty cell with a link is the link — there is nothing else to show.
  assert.equal(cellText({ hyperlink: DRIVE }), DRIVE);
});

test('the grid keeps the row numbering the values API has', () => {
  const grid = gridText([
    { values: [{ formattedValue: 'TÍTULO DEL VIDEO' }, { formattedValue: 'LINK VIDEO' }, { formattedValue: 'COPY' }] },
    {},
    { values: [{ formattedValue: 'A' }, { formattedValue: 'clip.mp4', hyperlink: DRIVE }, {}, {}] },
    { values: [{}, {}] },
    null,
  ]);
  assert.deepEqual(grid, [
    ['TÍTULO DEL VIDEO', 'LINK VIDEO', 'COPY'],
    [],
    ['A', 'clip.mp4 ' + DRIVE],
  ]);
  assert.deepEqual(gridText(null), []);
  assert.deepEqual(gridText([]), []);
});

// Unit tests for the sheet's network checkboxes. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublishedLink, isTicked, tickedNetworks } from './sheet-ticks.ts';

test('a checked box is a yes, in every shape the sheet writes one', () => {
  for (const v of ['TRUE', 'true', 'x', 'X', '✓', '✔', 'yes', 'si', 'sí', 'done', 'posted']) {
    assert.equal(isTicked(v), true, JSON.stringify(v) + ' should count as ticked');
  }
});

// Google's checkbox writes the literal word FALSE, not an empty cell.
test('an unchecked box is never a yes', () => {
  for (const v of ['FALSE', 'false', '', '   ', null, undefined, 'no', '0']) {
    assert.equal(isTicked(v as string), false, JSON.stringify(v) + ' should not count as ticked');
  }
});

// The one that was backwards: the published URL is a RECORD, not an order.
test('a published link means already posted, so it is not an instruction', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.equal(isPublishedLink(url), true);
  assert.equal(isTicked(url), false, 'a live video must not be queued a second time');
  assert.equal(isTicked('https://youtu.be/abc123'), false);
});

test('"Unlisted" typed in the column is not a link and not a tick', () => {
  assert.equal(isPublishedLink('Unlisted'), false);
  assert.equal(isTicked('Unlisted'), false);
});

const COLUMNS: [string, string][] = [
  ['youtube', 'youtube'], ['linkedin', 'linkedin'], ['tiktok', 'tiktok'],
  ['x', 'twitter'], ['facebook', 'facebook'], ['instagram', 'instagram'], ['email', 'email'],
];

test('a YouTube-only row asks for YouTube only', () => {
  const row: Record<string, string> = {
    youtube: 'TRUE', linkedin: 'FALSE', tiktok: 'FALSE', x: 'FALSE',
    facebook: 'FALSE', instagram: 'FALSE', email: 'FALSE',
  };
  assert.deepEqual(tickedNetworks(COLUMNS, (c) => row[c] || ''), ['youtube']);
});

test('a row already published to YouTube asks for nothing', () => {
  const row: Record<string, string> = { youtube: 'https://youtu.be/abc123' };
  assert.deepEqual(tickedNetworks(COLUMNS, (c) => row[c] || ''), []);
});

test('the X column maps to twitter, which is what Metricool calls it', () => {
  const row: Record<string, string> = { x: 'TRUE' };
  assert.deepEqual(tickedNetworks(COLUMNS, (c) => row[c] || ''), ['twitter']);
});

test('a row with nothing ticked asks for nothing — the caller decides the default', () => {
  assert.deepEqual(tickedNetworks(COLUMNS, () => 'FALSE'), []);
});

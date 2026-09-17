import test from 'node:test';
import assert from 'node:assert/strict';
import { filterQueue, matchesQueueSearch, type SearchablePost } from './queue-search.ts';

const SHEET = '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc';
const row183: SearchablePost = {
  text: 'Our Oxygen Circuit pairs hyperbaric oxygen therapy with red light therapy.',
  status: 'pending_review',
  providers: ['linkedin'],
  source: { spreadsheetId: SHEET, tab: '2026 CELLULAR HOPE', row: 183, gid: 0, title: 'Reel_Oxygen' },
};
const row184: SearchablePost = {
  text: 'Stem cells and sports injury rehab — what 183 studies say.',
  status: 'pending_review',
  providers: ['tiktok'],
  source: { spreadsheetId: SHEET, tab: '2026 CELLULAR HOPE', row: 184, gid: 0, title: 'Reel_Sports' },
};
const noSource: SearchablePost = { text: 'A hand-written post', status: 'pending_review', providers: ['facebook'], source: null };

test('a bare number is a ROW number and nothing else', () => {
  // The point of the whole module. Row 184's caption contains "183"; typing
  // 183 must find row 183 and not it.
  assert.equal(matchesQueueSearch(row183, '183'), true);
  assert.equal(matchesQueueSearch(row184, '183'), false);
  assert.deepEqual(filterQueue([row183, row184], '183'), [row183]);
});

test('a row number matches regardless of how the label is spelled', () => {
  assert.equal(matchesQueueSearch(row183, ' 183 '), true);
  assert.equal(matchesQueueSearch(row183, '18'), false, 'not a prefix match — 18 is its own row');
});

test('the tab, the network, the status and the copy are all searchable', () => {
  assert.equal(matchesQueueSearch(row183, 'cellular hope'), true);
  assert.equal(matchesQueueSearch(row183, 'linkedin'), true);
  assert.equal(matchesQueueSearch(row183, 'pending'), true);
  assert.equal(matchesQueueSearch(row183, 'hyperbaric'), true);
  assert.equal(matchesQueueSearch(row183, 'Reel_Oxygen'), true, 'the video title comes from the source');
  assert.equal(matchesQueueSearch(row183, 'tiktok'), false);
});

test('it is case-insensitive', () => {
  assert.equal(matchesQueueSearch(row183, 'HYPERBARIC'), true);
  assert.equal(matchesQueueSearch(row183, 'LinkedIn'), true);
});

test('an empty needle keeps everything, and the order is preserved', () => {
  assert.deepEqual(filterQueue([row183, row184, noSource], ''), [row183, row184, noSource]);
  assert.deepEqual(filterQueue([row183, row184], '   '), [row183, row184]);
  assert.equal(matchesQueueSearch(noSource, ''), true);
});

test('a post with no sheet row does not throw, and no number ever matches it', () => {
  assert.equal(matchesQueueSearch(noSource, 'hand-written'), true);
  assert.equal(matchesQueueSearch(noSource, '183'), false);
  assert.equal(matchesQueueSearch({}, 'anything'), false);
  assert.equal(matchesQueueSearch({}, '1'), false);
});

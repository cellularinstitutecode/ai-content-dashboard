// Unit tests for which ticked rows the dashboard's panel lists. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickRows } from './tick-rows.ts';
import { rowKeyFor } from './video-row.ts';

const LINK = 'https://drive.google.com/file/d/13oY95y-r09azOY1Ucd8MNzqU2QdDcfsJ/view?usp=drive_link';
const entry = (row: number, networks: string[], over: Partial<{ tab: string; title: string; videoLink: string }> = {}) =>
  ({ tab: '2026', row, title: 'Reel_Repair.mp4', videoLink: LINK, networks, ...over });
const sent = (network: string) => ({ network, ok: true });

test('a prepared row with a ticked network that has no post is ready, and says which networks are owed', () => {
  const runs = [{ tab: '2026', row_key: rowKeyFor('Reel_Repair.mp4', LINK), state: 'prepared', metricool: [sent('youtube'), sent('linkedin'), sent('tiktok')] }];
  const rows = tickRows([entry(224, ['youtube', 'linkedin', 'tiktok', 'facebook', 'instagram', 'twitter'])], runs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'ready');
  assert.deepEqual(rows[0].owed, ['facebook', 'instagram', 'twitter']);
  assert.equal(rows[0].row, 224);
});

test('a prepared row whose every tick already has its post is nothing new; an unprepared one is counted, not ready', () => {
  const runs = [{ tab: '2026', row_key: rowKeyFor('Reel_Repair.mp4', LINK), state: 'prepared', metricool: [sent('youtube')] }];
  const rows = tickRows([entry(224, ['youtube']), entry(10, ['facebook'], { videoLink: 'https://drive.google.com/file/d/other/view' })], runs);
  assert.deepEqual(rows.map((r) => r.state), ['nothing_new', 'not_prepared']);
  assert.deepEqual(rows[1].owed, []);
});

test('the row is found by its content key, and email is a column, not a network', () => {
  // The link cell holds a note around the link, as the real sheet does.
  const runs = [{ tab: '2026', row_key: rowKeyFor('Reel_Repair.mp4', LINK), state: 'prepared', metricool: [] }];
  const rows = tickRows([entry(224, ['email', 'facebook'], { videoLink: 'SUBS: ' + LINK + ' NO SUBS: https://drive.google.com/file/d/x/view' })], runs);
  assert.equal(rows[0].state, 'ready');
  assert.deepEqual(rows[0].ticked, ['facebook']);
  assert.deepEqual(rows[0].owed, ['facebook']);
  assert.deepEqual(tickRows([entry(5, [])], runs), [], 'a row with nothing ticked is not listed');
});

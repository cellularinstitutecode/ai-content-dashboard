// A button that opens the wrong row is worse than no button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetRowUrl, sheetRowLabel, sheetRowTitle, type PostSource } from './sheet-link.ts';

const full: PostSource = {
  spreadsheetId: '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc',
  tab: 'Distribución RRSS CHI',
  row: 183,
  gid: 412,
  title: 'Red light therapy',
};

test('a complete source opens that exact row', () => {
  // The shape Google's own "Get link to this cell" produces. Anything else
  // either fails to select the row or lands on the wrong tab.
  assert.equal(
    sheetRowUrl(full),
    'https://docs.google.com/spreadsheets/d/1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc/edit#gid=412&range=A183',
  );
});

test('gid 0 is a real tab id, not a missing one', () => {
  // The first tab of every spreadsheet has gid 0. A truthiness check here would
  // silently drop the most common case.
  assert.match(sheetRowUrl({ ...full, gid: 0 }) || '', /#gid=0&range=A183$/);
});

test('it degrades rather than guessing', () => {
  const base = 'https://docs.google.com/spreadsheets/d/' + full.spreadsheetId + '/edit';
  // No gid: the tab name cannot address a tab in a Sheets URL, so do not
  // pretend — open the document.
  assert.equal(sheetRowUrl({ ...full, gid: null }), base);
  // Tab but no row: the right tab, top of it.
  assert.equal(sheetRowUrl({ ...full, row: null }), base + '#gid=412');
  // Nothing to link to at all.
  assert.equal(sheetRowUrl({ ...full, spreadsheetId: '' }), null);
  assert.equal(sheetRowUrl(null), null);
  assert.equal(sheetRowUrl(undefined), null);
});

test('a nonsense row never reaches the URL', () => {
  const base = 'https://docs.google.com/spreadsheets/d/' + full.spreadsheetId + '/edit#gid=412';
  for (const row of [0, -3, NaN, Infinity] as number[]) {
    assert.equal(sheetRowUrl({ ...full, row }), base, 'row ' + row + ' was put in the URL');
  }
  // A float row is floored rather than written as "A12.7".
  assert.equal(sheetRowUrl({ ...full, row: 12.7 }), base + '&range=A12');
});

test('the label leads with the row number, which is what identifies a post', () => {
  assert.equal(sheetRowLabel(full), 'Distribución RRSS CHI · row 183');
  assert.equal(sheetRowLabel({ ...full, tab: '' }), 'row 183');
  assert.equal(sheetRowLabel({ ...full, row: null }), 'Distribución RRSS CHI');
  assert.equal(sheetRowLabel({ ...full, tab: '', row: null }), 'the sheet');
  assert.equal(sheetRowLabel(null), '');
});

test('the hover text names the video, because that is what a person recognises', () => {
  assert.match(sheetRowTitle(full), /Red light therapy/);
  assert.match(sheetRowTitle(full), /row 183/);
  // Untitled rows still get a usable sentence.
  assert.match(sheetRowTitle({ ...full, title: null }), /row 183/);
  assert.equal(sheetRowTitle(null), '');
});

test('a spreadsheet id is escaped rather than interpolated raw', () => {
  const url = sheetRowUrl({ ...full, spreadsheetId: 'a/b?c#d' }) || '';
  assert.doesNotMatch(url.split('/edit')[0], /[?#]/, 'an id broke out of the path');
});

// --- the button is actually wired up -----------------------------------------
import { readFileSync } from 'node:fs';
const readSrc = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('both publishing lists carry the row link', () => {
  for (const p of ['app/calendar/page.tsx', 'app/page.tsx']) {
    const src = readSrc(p);
    assert.match(src, /sheetRowUrl\(/, p + ' has no row link');
    assert.match(src, /sheetRowLabel\(/, p + ' shows no row number');
    assert.match(src, /rel="noopener noreferrer"/, p + ' opens the sheet unsafely');
  }
});

test('the API supplies the source from video_runs, in one query', () => {
  const src = readSrc('app/api/posts/route.ts');
  assert.match(src, /from\('video_runs'\)/);
  assert.match(src, /spreadsheet_id, tab, row_number, video_title/);
  assert.match(src, /\.in\('draft_id', draftIds\)/, 'the source read is not batched');
  // Scoped to the caller, like every other read on this route.
  const at = src.indexOf("from('video_runs')");
  assert.match(src.slice(at, at + 300), /\.eq\('user_id', user\.id\)/, 'video_runs is read unscoped');
});

test('a missing video_runs table cannot take the queue down', () => {
  // Its migration is pasted by hand like every other, so the table may simply
  // not exist. The row link is a convenience; the publishing list is not.
  const src = readSrc('app/api/posts/route.ts');
  const at = src.indexOf("from('video_runs')");
  assert.match(src.slice(at, at + 900), /reportError\('posts:source-read'/, 'the source read failure is unhandled');
});

test('gids are resolved once per tab and cached, not once per post', () => {
  const route = readSrc('app/api/posts/route.ts');
  assert.match(route, /if \(!gids\.has\(gidKey\)\)/, 'the gid is resolved per post');
  const src = readSrc('lib/google-sources.ts');
  assert.match(src, /export async function tabGid/);
  assert.match(src, /GID_TTL_MS/);
  // And it must never throw into the page.
  const at = src.indexOf('export async function tabGid');
  assert.match(src.slice(at, at + 1200), /catch \(e\)/, 'tabGid can throw into /api/posts');
});

// web/lib/prepared-rows.test.ts
//
// "I wanted to upload row 185 but when I put on Use in post it was a different
//  draft than what it was on the sheet — but it was prepared by the AI
//  dashboard, so there is a misconnection."
//
// There was. The button read the sheet's own COPY column, and the mapping from
// a row to the draft this app prepared for it — which video_runs has stored all
// along — was never consulted by that screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preparedByRow, rowKeyOf } from './prepared-rows.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a row is named the same way on both screens', () => {
  assert.equal(rowKeyOf('2026 CELLULAR HOPE', 186), '2026 CELLULAR HOPE:186');
  assert.equal(rowKeyOf(' 2026 CELLULAR HOPE ', 186.0), '2026 CELLULAR HOPE:186');
  // Row 1 is the header; a row number below 2 is not a row.
  assert.equal(rowKeyOf('Tab', 1), '');
  assert.equal(rowKeyOf('', 186), '');
  assert.equal(rowKeyOf('Tab', null), '');
});

test('each row points at the draft it was prepared into', () => {
  const map = preparedByRow([
    { tab: 'T', row: 185, draftId: 'd-185', title: 'Plasma Exchange at Cellular Institute' },
    { tab: 'T', row: 186, draftId: 'd-186', title: 'Red Light Therapy at Cellular Institute' },
  ]);
  assert.equal(map['T:185'].draftId, 'd-185');
  assert.equal(map['T:186'].draftId, 'd-186');
  assert.equal(map['T:186'].title, 'Red Light Therapy at Cellular Institute');
});

test('a row prepared twice hands over the NEWER draft', () => {
  // The subtlety that decides whether "Use in post" gives back copy that has
  // already been replaced.
  const map = preparedByRow([
    { tab: 'T', row: 186, draftId: 'old', updatedAt: '2026-09-01T00:00:00Z' },
    { tab: 'T', row: 186, draftId: 'new', updatedAt: '2026-09-17T00:00:00Z' },
  ]);
  assert.equal(map['T:186'].draftId, 'new');
  // With no timestamps at all, the caller's order decides — and /api/videos/runs
  // returns newest first.
  const byOrder = preparedByRow([{ tab: 'T', row: 9, draftId: 'first' }, { tab: 'T', row: 9, draftId: 'second' }]);
  assert.equal(byOrder['T:9'].draftId, 'first');
});

test('a row with no draft is absent, not empty', () => {
  // The caller falls back to the sheet's copy for exactly these, which is what
  // that column was always for.
  const map = preparedByRow([
    { tab: 'T', row: 187, draftId: '' },
    { tab: 'T', row: 188, draftId: null },
    { tab: '', row: 189, draftId: 'd' },
  ]);
  assert.deepEqual(Object.keys(map), []);
  assert.equal(preparedByRow(null) && Object.keys(preparedByRow(null)).length, 0);
});

// --- THE SCREENS USE IT -----------------------------------------------------

test('the Video Library hands over the PREPARED copy, not the sheet column', () => {
  const view = src('components/SourcesView.tsx');
  assert.match(view, /\/api\/videos\/runs/, 'it must know which draft belongs to the row');
  assert.match(view, /\/api\/drafts\?id=/, 'and must read that draft');
  assert.match(view, /pack\.tiktok, pack\.linkedin/, 'the prepared caption is what goes over');
  // The sheet's column stays as the fallback for a row nobody prepared.
  assert.match(view, /if \(!text\) text = \[v\.copy \|\| v\.title/, 'a row with no draft still hands over its sheet copy');
});

test('a hand-off can never leave the previous draft’s title in the box', () => {
  // A post about therapeutic plasma exchange sat under "Red Light Therapy at
  // Cellular Institute" — left behind by the draft opened before it, and that
  // is the title YouTube and TikTok would have published.
  const page = src('app/page.tsx');
  // Set ALWAYS, so an empty hand-off clears it. Via `handedTitle`, which the
  // auto-write below then reads to decide whether anything usable arrived.
  assert.match(page, /const handedTitle = workspace\.handoffTitle \|\| '';\s*\n\s*setMTitle\(handedTitle\)/);
  assert.match(page, /setMDraftId\(workspace\.handoffDraftId \|\| ''\)/);
  assert.ok(
    !/if \(workspace\.handoffTitle\) setMTitle/.test(page),
    'a conditional set is the bug: it keeps whatever was there before',
  );
});

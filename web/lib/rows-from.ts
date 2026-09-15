// web/lib/rows-from.ts
// "Everything from row N to the end" — as a selection, not a search.
//
// THE PROBLEM. The Video Library's batch prepares whatever is ticked, and the
// header checkbox ticks every VISIBLE row that still needs copy. "Prepare
// everything from row 179 onward" therefore meant ticking thirty-odd rows by
// hand, one search at a time — and the header tick would also have swept in
// the nineteen unfinished rows above 179, which are not the job.
//
// This decides which rows a "from row N" selection means, over the WHOLE
// sheet rather than the current search, so it can be tested without a
// browser and stated once.
//
// Pure and import-free: the test runner strips types and runs this directly.

/** The slice of a Video Library row this needs. */
export type RowLike = {
  tab: string;
  row: number;
  /** The link the batch would prepare from; empty when the row has no video. */
  link: string;
  copy: string;
};

/** Read what a person typed into "From row": a whole number ≥ 2, or null. */
export function parseFromRow(raw: string | number | null | undefined): number | null {
  const value = String(raw ?? '').trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 2 ? n : null;
}

/**
 * The keys (`tab:row`) of every row at or after `fromRow` that is actual
 * work — a video to read and no copy yet — in row order.
 *
 * Restricted to one tab when `tab` is given; the sheet's month tabs share row
 * numbers, and "from 179" almost always means "on the tab I am looking at".
 * With no tab it applies to every tab, which is what the sweep's own start
 * row does. Rows with copy are left alone: a filled cell is never work, and
 * ticking it would spend a run to change nothing.
 */
export function rowsFrom(rows: readonly RowLike[], fromRow: number | null, tab?: string | null): string[] {
  if (fromRow == null) return [];
  const wantTab = String(tab || '').trim().toLowerCase();
  return rows
    .filter((r) => r.row >= fromRow)
    .filter((r) => !wantTab || String(r.tab || '').trim().toLowerCase() === wantTab)
    .filter((r) => Boolean(String(r.link || '').trim()) && !String(r.copy || '').trim())
    .sort((a, b) => (a.tab === b.tab ? a.row - b.row : a.tab.localeCompare(b.tab)))
    .map((r) => r.tab + ':' + r.row);
}

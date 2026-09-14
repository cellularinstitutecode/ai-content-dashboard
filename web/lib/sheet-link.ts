// web/lib/sheet-link.ts
// Where a post came from, said in a way a person can act on.
//
// THE PROBLEM. The publishing list shows a date, a caption and a network. It
// does not say WHICH row of WHICH tab produced the post — so to edit the copy
// behind one of them, somebody had to open the sheet and hunt for a caption
// they could only half-remember from a two-line preview. Every post in that
// list came from a specific row of Rodrigo's sheet and the app knows exactly
// which one: video_runs records spreadsheet_id, tab and row_number (refreshed
// on every sweep, precisely so it can be written back to), and its draft_id is
// the same draft posts.draft_id points at.
//
// So the join already exists. All that was missing was showing it.
//
// Pure and import-free: the test runner strips types and runs this file
// directly, and a URL that silently points at the wrong row is worse than no
// button at all.

/** Where a post's copy was written from. */
export type PostSource = {
  spreadsheetId: string;
  /** The tab NAME, as the sweep recorded it. */
  tab: string;
  /** 1-based row number, as last seen by the sweep. */
  row: number | null;
  /** The tab's numeric id, when it is known. Google calls this `gid`. */
  gid: number | null;
  /** The video's title on that row, for recognising it at a glance. */
  title: string | null;
};

/**
 * A link that opens the sheet at that row.
 *
 * `#gid=<gid>&range=A<row>` is the exact shape Google's own "Get link to this
 * cell" produces, and it is the only form that selects a row on a named tab —
 * the tab NAME cannot address a tab in a Sheets URL.
 *
 * Degrades in two steps rather than guessing:
 *   gid + row → the row itself, selected.
 *   gid only  → the right tab, top of it.
 *   neither   → the document. Still the right document, and the label below
 *               carries the tab and row in words so the person can find it.
 *
 * Returns null when there is nothing to link to, so a caller can treat a truthy
 * result as "there is a button to draw".
 */
export function sheetRowUrl(source: PostSource | null | undefined): string | null {
  const id = String(source?.spreadsheetId ?? '').trim();
  if (!id) return null;
  const base = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit';
  if (source?.gid == null || !Number.isFinite(source.gid)) return base;
  const frag = '#gid=' + String(source.gid);
  const row = source?.row;
  if (row == null || !Number.isFinite(row) || row < 1) return base + frag;
  return base + frag + '&range=A' + String(Math.floor(row));
}

/**
 * The words on the button's label: which tab, which row.
 *
 * The row NUMBER is the point. It is the one thing that identifies a post
 * unambiguously to somebody looking at a spreadsheet, and a caption preview
 * truncated at two lines is not.
 */
export function sheetRowLabel(source: PostSource | null | undefined): string {
  if (!source?.spreadsheetId) return '';
  const tab = String(source.tab || '').trim();
  const row = source.row;
  const hasRow = row != null && Number.isFinite(row) && row >= 1;
  if (tab && hasRow) return tab + ' · row ' + Math.floor(row as number);
  if (hasRow) return 'row ' + Math.floor(row as number);
  if (tab) return tab;
  return 'the sheet';
}

/**
 * The hover text, which can afford to be a full sentence.
 *
 * Names the video too: on a tab of forty rows the title is what a person
 * actually recognises, and the row number is what they scroll to.
 */
export function sheetRowTitle(source: PostSource | null | undefined): string {
  if (!source?.spreadsheetId) return '';
  const where = sheetRowLabel(source);
  const title = String(source.title || '').trim();
  return title
    ? 'Open “' + title + '” in the sheet — ' + where
    : 'Open this post’s row in the sheet — ' + where;
}

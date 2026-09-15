// web/lib/sheet-cells.ts
// One cell of a Google Sheet, as the text the rest of the app reads — with the
// link that was hiding behind it.
//
// THE PROBLEM. The values API hands back what a cell DISPLAYS. A cell whose
// text is "Testimonio Lance_sub.mp4" with a Drive link attached (Insert →
// Link, or a pasted link Google turned into a title) displays the title, and
// the URL is invisible to that read. `firstLinkIn` (lib/video-row.ts) wants a
// literal https://, so every such row read as "no video link" and the sweep
// walked straight past it. Rows 179 onward of the clinic's sheet are entered
// that way.
//
// spreadsheets.get with a field mask returns the display text AND the link:
// `hyperlink` for a whole-cell link, `textFormatRuns[].format.link.uri` for a
// link on part of the text. This helper folds them into one string so the
// callers — the sweep, Prepare, the picker — need no change at all.
//
// Pure and import-free: the test runner strips types and runs this directly.

/** The slice of a CellData object this cares about. */
export type SheetCell = {
  formattedValue?: string | null;
  hyperlink?: string | null;
  textFormatRuns?: { format?: { link?: { uri?: string | null } | null } | null }[] | null;
} | null | undefined;

function firstUri(cell: SheetCell): string {
  const whole = String(cell?.hyperlink || '').trim();
  if (/^https?:\/\//i.test(whole)) return whole;
  for (const run of cell?.textFormatRuns || []) {
    const uri = String(run?.format?.link?.uri || '').trim();
    if (/^https?:\/\//i.test(uri)) return uri;
  }
  return '';
}

/**
 * The cell as text, with its link appended when the text does not already
 * carry one.
 *
 * Appended rather than substituted: the display text is what a person
 * recognises (and what becomes the video's title), and `firstLinkIn` finds
 * the URL wherever it sits. A cell that already shows a URL is left exactly
 * as the values API would have returned it, so nothing that worked changes.
 */
export function cellText(cell: SheetCell): string {
  const text = String(cell?.formattedValue ?? '');
  const uri = firstUri(cell);
  if (!uri || /https?:\/\//i.test(text)) return text;
  return text ? text + ' ' + uri : uri;
}

/**
 * A whole grid, in the shape the values API returns: row i is sheet row
 * i + 1, cells past the last non-empty one are dropped, and empty rows are
 * empty arrays. Trailing empty rows are dropped too, so the two reads agree
 * about how many rows there are.
 */
export function gridText(rowData: ({ values?: SheetCell[] | null } | null | undefined)[] | null | undefined): string[][] {
  const rows: string[][] = (rowData || []).map((r) => {
    const cells = (r?.values || []).map(cellText);
    let end = cells.length;
    while (end > 0 && !cells[end - 1]) end--;
    return cells.slice(0, end);
  });
  let last = rows.length;
  while (last > 0 && !rows[last - 1].length) last--;
  return rows.slice(0, last);
}

/** The slice of a row's metadata this cares about: is the row hidden? */
export type SheetRowMeta = { hiddenByUser?: boolean | null; hiddenByFilter?: boolean | null } | null | undefined;

/**
 * The 1-based sheet row numbers that are hidden — by a person (right-click →
 * Hide) or by a filter. Either way the clinic has put the row out of sight,
 * and the app treats out of sight as out of bounds: never registered, never
 * prepared, never written to. The instruction was literal: "whatever is
 * hidden should remain hidden."
 *
 * `rowMetadata` from spreadsheets.get lines up with the grid from row 1 when
 * the whole tab is requested, which is how readTab asks for it.
 */
export function hiddenRows(meta: readonly SheetRowMeta[] | null | undefined, firstRow = 1): Set<number> {
  const out = new Set<number>();
  (meta || []).forEach((m, i) => {
    if (m?.hiddenByUser || m?.hiddenByFilter) out.add(firstRow + i);
  });
  return out;
}

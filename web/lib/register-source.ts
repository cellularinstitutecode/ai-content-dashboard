// web/lib/register-source.ts
// Where a register entry came from in the sheet, in the shape the row link wants.
//
// THE PROBLEM. The "Recently added" panel listed thirty-three videos by title
// and said nothing about WHERE they are. The register has known all along:
// every first_seen entry records `detail.row` and `detail.tab`, and the key
// itself starts with the spreadsheet id (lib/video-event.ts `videoKeyFor`
// joins `spreadsheetId|tab|rowKey`). Nothing read it back.
//
// This turns one entry into the PostSource that lib/sheet-link.ts already
// renders for the publishing lists, so the register shows the same
// "Tab · row 179 ↗" chip and opens the sheet at that row.
//
// Pure and import-free (a type import only): the test runner strips types and
// runs this file directly.
import type { PostSource } from './sheet-link';

/** What a register entry looks like once it has reached the browser. */
export type RegisterLike = {
  videoKey?: unknown;
  title?: unknown;
  detail?: Record<string, unknown> | null;
};

function wholeNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  return whole >= 0 ? whole : null;
}

/**
 * The sheet coordinates of an entry, or null when it has none.
 *
 * Degrades the way sheetRowUrl does: an entry written before the gid was
 * recorded still yields the document and the row NUMBER in words; a Drive-only
 * key (`drive|<fileId>`, a file attached straight from the picker) yields null
 * because there is no row to point at — and no chip is drawn rather than a
 * chip that opens the wrong place.
 */
export function registerSource(entry: RegisterLike | null | undefined): PostSource | null {
  const key = String(entry?.videoKey ?? '').trim();
  if (!key || key.startsWith('drive|') || key.startsWith('sweep|')) return null;
  const [spreadsheetId, keyTab] = key.split('|');
  if (!spreadsheetId) return null;

  const d = (entry?.detail && typeof entry.detail === 'object' ? entry.detail : {}) as Record<string, unknown>;
  const tab = String(d.tab ?? keyTab ?? '').trim();
  const row = wholeNumber(d.row);
  // Row 1 is the header at best; a row that cannot be a data row is not shown.
  const dataRow = row != null && row >= 2 ? row : null;
  const gid = wholeNumber(d.gid);
  if (!tab && dataRow == null) return null;

  return {
    spreadsheetId,
    tab,
    row: dataRow,
    gid,
    title: entry?.title == null ? null : String(entry.title),
  };
}

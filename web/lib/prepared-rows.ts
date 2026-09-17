// web/lib/prepared-rows.ts
// Which prepared draft belongs to which row of the sheet.
//
// video_runs has recorded this since the pipeline was built — tab, row number,
// and the draft each row was prepared into — and the Video Library never read
// it. So "Use in post · with video" handed the composer the sheet's own COPY
// column instead of the copy this app had written, and a row that had been
// through Prepare reached Metricool carrying text nobody had prepared for it:
//
//   "I wanted to upload row 185 but when I put on Use in post it was a
//    different draft than what it was on the sheet."
//
// Pure: no imports, so the test runner reads this file directly.

export type RunRow = {
  tab?: string | null;
  row?: number | null;
  draftId?: string | null;
  title?: string | null;
  updatedAt?: string | null;
};

export type PreparedRow = { draftId: string; title: string };

/** "2026 CELLULAR HOPE:186" — the one key both screens agree on. */
export function rowKeyOf(tab: string | null | undefined, row: number | null | undefined): string {
  const t = String(tab || '').trim();
  const n = Number(row);
  if (!t || !Number.isFinite(n) || n < 2) return '';
  return t + ':' + Math.floor(n);
}

/**
 * The draft each row is currently prepared into.
 *
 * NEWEST WINS, and that is the whole subtlety: a row prepared twice has two
 * runs, and handing over the first one gives back copy that was replaced. The
 * caller passes rows newest-first (which is how /api/videos/runs returns them),
 * and a later row never overwrites an earlier one; when `updatedAt` is present
 * it is compared rather than trusted to the order.
 */
export function preparedByRow(rows: readonly RunRow[] | null | undefined): Record<string, PreparedRow> {
  const out: Record<string, PreparedRow> = {};
  const stamps: Record<string, number> = {};
  for (const r of rows || []) {
    const key = rowKeyOf(r?.tab, r?.row);
    const draftId = String(r?.draftId || '').trim();
    if (!key || !draftId) continue;
    const at = Date.parse(String(r?.updatedAt || '')) || 0;
    // Without a timestamp the first one seen wins, because the caller's order
    // is newest-first; with one, the newer always does.
    if (key in out && at <= (stamps[key] ?? 0)) continue;
    out[key] = { draftId, title: String(r?.title || '') };
    stamps[key] = at;
  }
  return out;
}

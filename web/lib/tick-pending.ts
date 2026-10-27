// web/lib/tick-pending.ts
// Which ticks from the sheet are still waiting for a time.
//
// A box ticked in the sheet reaches the dashboard through the sheet's edit
// trigger, which names no time; the row is held and a `ticked` line goes in
// the register (lib/video-ticks.ts, hold). The dashboard's Prepare checked
// boxes panel lists those rows first, pre-selected — they are what the person
// just did — and the rest of the sheet's ticked history below, unselected.
//
// A tick is pending until a `queued` line for the same video comes after it:
// the panel's Send, the sweep, Prepare, all write one. Pure, so it is
// unit-tested; app/api/videos/ticks/route.ts supplies the register rows.

export type RegisterLine = { videoKey: string; event: string; createdAt: string; detail?: Record<string, unknown> | null };

export type PendingTick = { videoKey: string; tab: string; row: number; at: string; owed: string[] };

/** The pending ticks, newest first, one per video. `rows` may be in any order. */
export function pendingTicks(rows: readonly RegisterLine[]): PendingTick[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const closed = new Set<string>();
  const seen = new Set<string>();
  const out: PendingTick[] = [];
  for (const r of sorted) {
    const key = String(r.videoKey || '');
    if (!key) continue;
    if (r.event === 'queued') { closed.add(key); continue; }
    if (r.event !== 'ticked' || closed.has(key) || seen.has(key)) continue;
    seen.add(key);
    const d = r.detail || {};
    const row = Number(d.row);
    if (!Number.isInteger(row)) continue;
    out.push({ videoKey: key, tab: String(d.tab || ''), row, at: r.createdAt, owed: Array.isArray(d.owed) ? (d.owed as unknown[]).map(String) : [] });
  }
  return out;
}

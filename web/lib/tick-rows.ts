// web/lib/tick-rows.ts
// Which rows of the video sheet have boxes ticked that are still owed a post.
//
// The dashboard's "Prepare checked boxes" panel (components/TickScheduler.tsx)
// lists these so a person can pick a day and a time and send them, without
// touching the sheet's script. The rule is the one the sheet's panel and the
// edit trigger already apply, read from the same two sources: the ticks on
// the row (lib/sheet-ticks.ts, already on each VideoEntry as `networks`) and
// the row's record of what was sent (video_runs.metricool → lib/tick-add.ts
// networksToAdd). A row is found by its content key, as the sweep finds it.
//
// Three answers per ticked row:
//   ready        prepared, and at least one ticked network has no post yet;
//   nothing_new  prepared, and every ticked network already has its post;
//   not_prepared no prepared record — most such rows are old ones where a
//                tick is a record of something published by hand, which is
//                why they are counted rather than listed.
//
// Pure, so it is unit-tested; app/api/videos/ticks/route.ts supplies the data.
import { networksToAdd, type PriorOutcome } from './tick-add.ts';
import { firstLinkIn, rowKeyFor } from './video-row.ts';

export type TickEntry = { tab: string; row: number; title: string; videoLink: string; networks: string[] };
export type TickRun = { tab: string; row_key: string; state?: string | null; metricool?: unknown };

export type TickRow = {
  tab: string;
  row: number;
  title: string;
  ticked: string[];
  owed: string[];
  state: 'ready' | 'nothing_new' | 'not_prepared';
};

/** The ticked rows, each with what it is still owed. Rows with nothing ticked are not rows here. */
export function tickRows(entries: readonly TickEntry[], runs: readonly TickRun[]): TickRow[] {
  const byKey = new Map<string, TickRun>();
  for (const r of runs) byKey.set(r.tab + '\u0000' + r.row_key, r);
  const out: TickRow[] = [];
  for (const e of entries) {
    const ticked = (e.networks || []).map((n) => String(n || '').toLowerCase()).filter((n) => n && n !== 'email');
    if (!ticked.length) continue;
    const link = firstLinkIn(e.videoLink || '');
    const run = byKey.get(e.tab + '\u0000' + rowKeyFor(e.title, link));
    if (!run || run.state !== 'prepared') {
      out.push({ tab: e.tab, row: e.row, title: e.title || link, ticked, owed: [], state: 'not_prepared' });
      continue;
    }
    const prior = Array.isArray(run.metricool) ? (run.metricool as PriorOutcome[]) : [];
    const owed = networksToAdd(ticked, prior);
    out.push({ tab: e.tab, row: e.row, title: e.title || link, ticked, owed, state: owed.length ? 'ready' : 'nothing_new' });
  }
  return out;
}

// web/lib/missed-slot.ts
// Where a post that missed its slot can still go.
//
// A strategy post the team did not get to by its time used to be a dead card:
// approving it sent Metricool a publication date in the past, which Metricool
// refuses, and after a day it dropped out of the queue entirely. The honest
// options are "skip it" or "put it out at the next sensible moment" — and the
// next sensible moment is not "now": it is a time inside the clinic's posting
// hours, in the clinic's time zone, that is not stacked on top of something
// already going out.
//
// Pure: imports only ./timezone.ts, so the test runner reads this file directly.
import { SCHEDULE_TZ, wallClockInTz } from './timezone.ts';

export type FreeSlotOptions = {
  now: Date;
  /** Instants already taken — scheduled posts and runs still on their way. */
  busy?: readonly Date[];
  tz?: string;
  /** Local posting window, "HH:MM", inclusive at both ends. */
  windowStart?: string;
  windowEnd?: string;
  /** Minimum distance, in minutes, from anything in `busy`. */
  gapMin?: number;
  /** Candidates sit on this grid, in minutes past the hour. */
  stepMin?: number;
  /** Nothing sooner than this many minutes from now: approval still has to reach Metricool. */
  leadMin?: number;
  /** How far ahead to look before giving up. */
  searchDays?: number;
};

function minutesOf(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return fallback;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 24 * 60 ? v : fallback;
}

/**
 * The earliest instant on the grid that is at least `leadMin` away, inside the
 * posting window in `tz`, and at least `gapMin` from every busy instant.
 * Null when nothing fits within `searchDays`.
 */
export function nextFreeSlot(opts: FreeSlotOptions): Date | null {
  const tz = opts.tz || SCHEDULE_TZ;
  const start = minutesOf(opts.windowStart || '08:00', 8 * 60);
  const end = minutesOf(opts.windowEnd || '20:00', 20 * 60);
  const gapMs = Math.max(0, opts.gapMin ?? 60) * 60_000;
  const stepMs = Math.max(1, opts.stepMin ?? 15) * 60_000;
  const leadMs = Math.max(0, opts.leadMin ?? 15) * 60_000;
  const until = opts.now.getTime() + Math.max(1, opts.searchDays ?? 7) * 24 * 60 * 60_000;
  const busy = (opts.busy || []).map((d) => d.getTime()).filter((t) => Number.isFinite(t));

  // Grid-aligned in absolute time. Every zone the clinic could use is offset
  // from UTC by a whole number of quarter hours, so this is also the local grid.
  let t = Math.ceil((opts.now.getTime() + leadMs) / stepMs) * stepMs;
  for (; t <= until; t += stepMs) {
    const w = wallClockInTz(new Date(t), tz);
    const local = w.hh * 60 + w.mm;
    if (local < start || local > end) continue;
    if (busy.some((b) => Math.abs(b - t) < gapMs)) continue;
    return new Date(t);
  }
  return null;
}

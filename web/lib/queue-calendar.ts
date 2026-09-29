// web/lib/queue-calendar.ts
// The dashboard's publishing queue, laid out as a month instead of a list.
//
// The month is the calendar page's own shape: six rows of seven days, Sunday
// first, so a post sits on the same square on both pages. A day is the
// schedule's wall-clock day (lib/schedule-clock.ts scheduleDateKey), never the
// browser's — a 6 PM Cancun post must not land on tomorrow for someone in
// Madrid. Clicking a day shows that day's posts underneath, with every button
// the list had; a search or "Select several" shows every match instead.
//
// Pure: no imports, so the test runner reads this file directly. Day keys are
// passed in, already computed, so this file never needs a time zone.

export type MonthCursor = { year: number; month: number };

/** "YYYY-MM-DD" for a calendar Date (its own fields — it is a grid square, not an instant). */
export function gridKey(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 42 days covering the month: from the Sunday on or before the 1st. */
export function monthGrid({ year, month }: MonthCursor): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** The month a "YYYY-MM-DD" key falls in. */
export function cursorOf(key: string): MonthCursor | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(key);
  return m ? { year: Number(m[1]), month: Number(m[2]) - 1 } : null;
}

export function shiftMonth(c: MonthCursor, by: number): MonthCursor {
  const d = new Date(c.year, c.month + by, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Posts by day key, each day in time order. */
export function groupByDay<T>(posts: readonly T[], dayOf: (p: T) => string, timeOf: (p: T) => number): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const p of posts) {
    const k = dayOf(p);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(p);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort((a, b) => timeOf(a) - timeOf(b));
  return out;
}

/**
 * The day to open on: today if anything is on it, otherwise the next day that
 * has a post, otherwise the latest day that had one, otherwise today.
 */
export function defaultDay(days: Iterable<string>, todayKey: string): string {
  const all = [...days].filter(Boolean).sort();
  if (!all.length || all.includes(todayKey)) return todayKey;
  return all.find((k) => k > todayKey) ?? all[all.length - 1];
}

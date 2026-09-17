// web/lib/daily-pace.ts
// The rules behind "two videos a day, from row 179 onward".
//
// The sweep used to walk every tab from the top and stop after N ATTEMPTS per
// run. Three things that were wrong for the clinic's cadence, and this module
// holds the decision for each:
//
//  1. WHERE TO START. Nineteen rows above 179 still have an empty COPY cell,
//     and the sweep would have spent the day's pair on them. VIDEO_START_ROW
//     names the first row the sweep is allowed to prepare.
//  2. HOW MANY A DAY. "Two a day" is a count of rows PREPARED TODAY across
//     every run — the nightly cron, the sheet's edit trigger, a person's
//     Prepare — not a per-run attempt cap, which a failure would eat and an
//     afternoon run would refill.
//  3. WHEN TODAY STARTS. On the clinic's clock, not the server's: Vercel runs
//     in UTC, and the nightly run at 07:00 UTC is 02:00 in Cancún — the same
//     day whose 08:00 and 17:00 slots it is about to book.
//
// Pure and import-free: the test runner strips types and runs this directly.

export type StartRow = { tab: string | null; row: number };

/**
 * Where the sweep starts when nothing says otherwise.
 *
 * A default in code rather than a setting somebody has to type into a host:
 * the clinic's instruction was "from row 179 onward", and the rows above it
 * are finished months that must not be re-done. VIDEO_START_ROW still wins
 * when set; `VIDEO_START_ROW=none` (or `0`) switches the rule off entirely.
 */
export const DEFAULT_START_ROW = 179;

/**
 * Read VIDEO_START_ROW. `179` applies to every tab; `Marzo!179` to that tab
 * only (other tabs are unrestricted). Unset → the default above. `none` or
 * `0` → no rule. Anything else unreadable → the default, never a guess at a
 * different number.
 */
export function parseStartRow(raw: string | null | undefined): StartRow | null {
  if (raw === undefined || raw === null) return { tab: null, row: DEFAULT_START_ROW };
  const value = String(raw).trim();
  if (!value) return { tab: null, row: DEFAULT_START_ROW };
  if (/^(none|off|0)$/i.test(value)) return null;
  const bang = value.lastIndexOf('!');
  const tabPart = bang >= 0 ? value.slice(0, bang).trim().replace(/^'(.*)'$/, '$1') : '';
  const rowPart = bang >= 0 ? value.slice(bang + 1).trim() : value;
  if (!/^\d+$/.test(rowPart)) return { tab: null, row: DEFAULT_START_ROW };
  const row = Number(rowPart);
  if (!Number.isInteger(row) || row < 2) return { tab: null, row: DEFAULT_START_ROW };
  return { tab: tabPart || null, row };
}

/** Is this row before the start — seen, but not the sweep's to prepare? */
export function belowStart(tab: string, row: number, start: StartRow | null): boolean {
  if (!start) return false;
  if (start.tab && start.tab.trim().toLowerCase() !== String(tab || '').trim().toLowerCase()) return false;
  return row < start.row;
}

/** Read VIDEO_DAILY_QUOTA: a whole number of rows per day, or null for no daily rule. */
export function parseQuota(raw: string | null | undefined): number | null {
  const value = String(raw ?? '').trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

/**
 * How many more rows the day allows, given what is already prepared today.
 * Null quota means "no daily rule": the caller keeps its own ceiling.
 */
export function remainingQuota(quota: number | null, preparedToday: number): number | null {
  if (quota == null) return null;
  return Math.max(0, quota - Math.max(0, Math.trunc(preparedToday) || 0));
}

/**
 * The UTC instant at which today began on the clinic's clock.
 *
 * Intl only, like lib/timezone.ts: the offset is whatever `tz` shows at `now`,
 * applied twice so a DST edge (Cancún has none) still lands on midnight.
 */
export function startOfDayIso(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || '0');
  const y = get('year'), m = get('month'), d = get('day');
  const shown = Date.UTC(y, m - 1, d, get('hour') % 24, get('minute'), get('second'));
  const offset = shown - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset).toISOString();
}

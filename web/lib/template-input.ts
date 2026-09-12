// web/lib/template-input.ts
// Cleaning the two fields that decide WHEN a schedule template fires.
//
// These lived as private functions in app/api/templates/route.ts, which was
// fine while a route was the only way to make a template. The assistant can now
// create them too, and a second implementation of "what counts as a valid time"
// is how you end up with a template the planner silently fires at 09:00 because
// something upstream accepted "9am" and wrote it through.
//
// No imports: the test runner strips types and runs this file directly.

/** Sunday is 0, matching Date#getDay and the weekdays column. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The weekdays worth keeping: whole numbers 0–6, deduplicated, in order.
 *
 * Anything else is dropped rather than rejected — a template with one bad entry
 * in its list should lose that entry, not fail to save.
 */
export function cleanWeekdays(x: unknown): number[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<number>();
  for (const v of x) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * A 24-hour "HH:MM", or 09:00.
 *
 * The default is not arbitrary and is not a silent failure: a template with no
 * usable time still has to fire somewhere, and mid-morning clinic-local is the
 * least surprising place. Callers that care whether the value was understood
 * should compare the result with what they sent.
 */
export function cleanTime(x: unknown): string {
  const s = (x ?? '').toString();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '09:00';
}

/** Did cleanTime actually understand this, or fall back? Lets a caller say so. */
export function isUsableTime(x: unknown): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test((x ?? '').toString());
}

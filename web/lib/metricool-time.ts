// web/lib/metricool-time.ts
// The ONE conversion between "what the user asked for" and what Metricool
// wants, which is a wall-clock datetime plus the zone it belongs to:
//   { dateTime: 'YYYY-MM-DDTHH:MM:SS', timezone: TIMEZONE }
//
// This lived inside app/api/metricool/schedule/route.ts, where it could not be
// imported and could not be unit-tested, so it was written a second time in
// app/api/assistant/route.ts — and that copy still contained the exact bug this
// one was written to fix: it stripped a trailing `Z`/offset and passed the
// remaining digits through, silently reinterpreting a UTC instant as clinic
// local time (five hours late for Cancun). Two behaviours, one endpoint,
// depending on whether you asked the chat assistant or pressed the button.
//
// Both callers are handled here:
//   • an absolute instant (ends in Z or ±HH:MM) is CONVERTED to wall-clock;
//   • a naive value is taken as already being wall-clock in TIMEZONE.

export const METRICOOL_TIMEZONE =
  process.env.METRICOOL_TIMEZONE || 'America/Cancun';

/** What the clock in `timeZone` reads at `instant`, as 'YYYY-MM-DDTHH:MM:SS'. */
export function toZonedWallClock(instant: Date, timeZone: string = METRICOOL_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  // en-CA + hour12:false can render midnight as "24"; normalise it.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return get('year') + '-' + get('month') + '-' + get('day') + 'T' + hour + ':' + get('minute') + ':' + get('second');
}

/**
 * Turn whatever a caller supplied into the pair Metricool needs and the
 * absolute instant we store locally. Returns null when the input is not a
 * usable datetime at all — callers must treat that as a rejected request
 * rather than scheduling something they guessed.
 */
export function normalizePublishAt(
  input: string,
  timeZone: string = METRICOOL_TIMEZONE
): { wallClock: string; instant: string } | null {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const absolute = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (absolute) {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return { wallClock: toZonedWallClock(d, timeZone), instant: d.toISOString() };
  }

  let s = raw.replace(/\.\d+$/, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s = s + ':00';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;

  // Recover the absolute instant for the naive wall-clock by measuring the
  // zone's offset at that moment (handles DST without a tz database).
  const guess = new Date(s + 'Z');
  if (isNaN(guess.getTime())) return null;
  const offsetMs = new Date(toZonedWallClock(guess, timeZone) + 'Z').getTime() - guess.getTime();
  return { wallClock: s, instant: new Date(guess.getTime() - offsetMs).toISOString() };
}

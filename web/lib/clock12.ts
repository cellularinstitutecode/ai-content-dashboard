// web/lib/clock12.ts
// A stored HH:MM ("09:00", "13:30") as a person reads it: "9:00 AM", "1:30 PM".
//
// Templates, the weekly planner, a dropped strategy's slots and the calendar's
// weekly plan all keep their time of day as 24-hour HH:MM (the shape the
// database stores and <input type="time"> speaks), and each printed that
// string as it was. The team reads a 12-hour clock, so every screen prints
// through this instead; storage and the inputs keep HH:MM.
//
// Pure: no imports, so the test runner reads this file directly.

/**
 * "09:00" → "9:00 AM", "13:30" → "1:30 PM", "00:00" → "12:00 AM". Seconds are
 * dropped. Anything that is not a clock time comes back as it was, so a
 * label never turns into "undefined".
 */
export function fmtClock12(hhmm: unknown, opts: { compact?: boolean } = {}): string {
  const s = String(hhmm ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return s;
  const h = Number(m[1]);
  const min = m[2];
  if (h > 23 || Number(min) > 59) return s;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  // compact: "9 AM" when the minutes are :00 — for a calendar chip with no room.
  if (opts.compact && min === '00') return h12 + ' ' + period;
  return h12 + ':' + min + ' ' + period;
}

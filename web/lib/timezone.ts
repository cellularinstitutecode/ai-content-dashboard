// web/lib/timezone.ts
// One shared clock for every scheduler in the app.
//
// The dashboard's promise is "times are in America/Cancun", but Vercel
// serverless runs in UTC — so any code that builds a Date with setHours()
// silently schedules 5 hours early (a 09:00 template fired at 4 AM Cancun).
// Everything that turns a wall-clock time into an instant now goes through
// here: Autopilot planning (lib/autopilot), template Apply
// (api/templates/apply) and the Metricool handoff (lib/metricool).
//
// No dependencies: offsets come from Intl, which ships with Node.

export const SCHEDULE_TZ =
  process.env.SCHEDULE_TIMEZONE || process.env.METRICOOL_TIMEZONE || 'America/Cancun';

type WallClock = { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// What the wall clock in `tz` shows at the UTC instant `at`.
export function wallClockInTz(at: Date, tz: string = SCHEDULE_TZ): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '0';
  return {
    y: parseInt(get('year'), 10),
    m: parseInt(get('month'), 10),
    d: parseInt(get('day'), 10),
    hh: parseInt(get('hour'), 10) % 24, // Intl can emit "24" at midnight
    mm: parseInt(get('minute'), 10),
    ss: parseInt(get('second'), 10),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

// Offset (ms) of `tz` from UTC at the instant `at` (e.g. Cancun → -5h).
export function tzOffsetMs(at: Date, tz: string = SCHEDULE_TZ): number {
  const w = wallClockInTz(at, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  // Round to the minute — formatToParts drops sub-second precision.
  return Math.round((asUtc - (Math.floor(at.getTime() / 1000) * 1000)) / 60000) * 60000;
}

// The UTC instant at which the wall clock in `tz` reads y-m-d hh:mm.
// Two-pass offset lookup keeps this correct across DST transitions (Cancun
// has none, but the helper should not depend on that).
export function zonedTimeToUtc(
  y: number, m: number, d: number, hh: number, mm: number, tz: string = SCHEDULE_TZ
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  const better = guess - offset;
  const offset2 = tzOffsetMs(new Date(better), tz);
  return new Date(guess - offset2);
}

// All upcoming occurrences of `weekdays` (0=Sun..6=Sat) at `timeOfDay`
// ("HH:MM"), interpreted in `tz`, within (now, now + horizonDays]. Returned
// as UTC instants ready for toISOString()/DB storage, sorted ascending.
export function upcomingSlots(
  weekdays: number[],
  timeOfDay: string,
  horizonDays: number,
  tz: string = SCHEDULE_TZ,
  now: Date = new Date()
): Date[] {
  const clean = Array.from(new Set(
    (Array.isArray(weekdays) ? weekdays : [])
      .map((w) => Number(w))
      .filter((w) => Number.isInteger(w) && w >= 0 && w <= 6)
  ));
  if (!clean.length) return [];
  const [hhRaw, mmRaw] = String(timeOfDay || '09:00').split(':').map((n) => parseInt(n, 10));
  const hh = Number.isFinite(hhRaw) ? Math.min(Math.max(hhRaw, 0), 23) : 9;
  const mm = Number.isFinite(mmRaw) ? Math.min(Math.max(mmRaw, 0), 59) : 0;

  const today = wallClockInTz(now, tz);
  const horizonMs = now.getTime() + horizonDays * 24 * 60 * 60 * 1000;
  const out: Date[] = [];
  for (let w = 0; w < Math.ceil(horizonDays / 7) + 1; w++) {
    for (const wd of clean) {
      const delta = (wd - today.weekday + 7) % 7 + w * 7;
      const slot = zonedTimeToUtc(today.y, today.m, today.d + delta, hh, mm, tz);
      if (slot.getTime() <= now.getTime() || slot.getTime() > horizonMs) continue;
      out.push(slot);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

// Format a UTC instant as the "YYYY-MM-DDTHH:MM:SS" wall-clock string
// Metricool expects alongside its `timezone` field.
export function formatForMetricool(at: Date, tz: string = SCHEDULE_TZ): string {
  const w = wallClockInTz(at, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.m)}-${p(w.d)}T${p(w.hh)}:${p(w.mm)}:${p(w.ss)}`;
}

// web/lib/schedule-clock.ts
// One clock for everything a person READS, to match lib/timezone.ts — the one
// clock for everything the app WRITES.
//
// The bug this exists to kill: the composer promised "times are in
// America/Cancun" and the server honoured that, but every list on the screen
// rendered the same instant with toLocaleString(undefined, …) — the *browser's*
// timezone. A coordinator in Tijuana scheduled a post for 9:00 AM, and the
// queue and the calendar immediately told them it was 7:00 AM. Same post, three
// panels, two different answers.
//
// Client components cannot read SCHEDULE_TIMEZONE (it is a server variable), so
// the server stamps the resolved zone on <html data-schedule-tz> in the root
// layout and everything here reads it back. No new environment variable to set,
// and no way for the two clocks to drift apart.

import { wallClockInTz, zonedTimeToUtc } from './timezone.ts';

export const DEFAULT_SCHEDULE_TZ = 'America/Cancun';

/** The timezone every scheduled time in the UI is displayed in. */
export function scheduleTz(): string {
  if (typeof document !== 'undefined') {
    const stamped = document.documentElement.dataset.scheduleTz;
    if (stamped) return stamped;
  }
  return DEFAULT_SCHEDULE_TZ;
}

/** "Cancun" — the city, for a label a person reads, not the IANA string. */
export function scheduleTzLabel(tz: string = scheduleTz()): string {
  const city = tz.split('/').pop() || tz;
  return city.replace(/_/g, ' ');
}

function fmt(input: unknown, opts: Intl.DateTimeFormatOptions): string {
  try {
    const d = new Date(input as string);
    if (isNaN(d.getTime())) return String(input ?? '');
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: scheduleTz() }).format(d);
  } catch {
    return String(input ?? '');
  }
}

/** "Sep 1, 9:00 AM" — a scheduled post in a list. */
export function fmtScheduleDateTime(input: unknown): string {
  return fmt(input, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "Tue, Sep 1, 9:00 AM" — a slot that needs its weekday. */
export function fmtScheduleSlot(input: unknown): string {
  return fmt(input, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "09:00 AM" — the time alone, for a calendar cell. */
export function fmtScheduleTime(input: unknown): string {
  return fmt(input, { hour: '2-digit', minute: '2-digit' });
}

/** "2026-09-01" in the schedule zone — the key a calendar grid buckets by. */
export function scheduleDateKey(input: unknown): string {
  try {
    const d = new Date(input as string);
    if (isNaN(d.getTime())) return '';
    // en-CA renders ISO-shaped YYYY-MM-DD, which is exactly the key shape.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: scheduleTz(), year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch { return ''; }
}

/**
 * "YYYY-MM-DDTHH:MM" for a <input type="datetime-local">, `days` from now at
 * `hour` — computed on the SCHEDULE clock, not the browser's. A preset labelled
 * "Tomorrow 9 AM" pressed at 11pm Tijuana used to land on the wrong day.
 */
export function schedulePresetValue(days: number, hour: number, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: scheduleTz(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  // Date arithmetic in UTC so the day roll cannot be shifted by the browser zone.
  const base = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + days));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}T${p(hour)}:00`;
}

/**
 * The instant at which the schedule clock reads y-m-d hh:mm.
 *
 * The calendar used to build this with `new Date(day); setHours(9,0)` — the
 * BROWSER's 9 AM. From Tijuana that is 11 AM in Cancun, so a post the calendar
 * labelled "09:00" went out two hours late. Same two-pass, DST-safe conversion
 * the server schedules with (lib/timezone.ts), so both ends agree.
 */
export function isoAtScheduleWallClock(
  y: number, m: number, d: number, hh: number, mm: number
): string {
  return zonedTimeToUtc(y, m, d, hh, mm, scheduleTz()).toISOString();
}

/** What the schedule clock reads at a given instant. */
export function scheduleWallClock(input: unknown) {
  const at = new Date(input as string);
  return wallClockInTz(isNaN(at.getTime()) ? new Date() : at, scheduleTz());
}

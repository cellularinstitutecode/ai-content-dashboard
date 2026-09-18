// web/lib/planner-slot.ts
// "Put this post on Tuesday" — turning a weekly planner theme into a date.
//
// The planner has held a theme per day since it was built (Monday 09:00,
// instagram/facebook/linkedin…), and the only place it could be used was the
// Autopilot, which writes its OWN post for that slot. A post already written —
// the one on the screen — could not be placed on a day at all: the panel
// offered "the next free slots" and a datetime box, and the planner sat on
// another page.
//
// Pure: no imports, so the test runner reads this file directly.

export type PlannerTheme = {
  id: string;
  name: string;
  /** 0 = Sunday, as JavaScript counts and as the templates store it. */
  days: number[];
  /** "09:00" — the slot's time of day, in the clinic's timezone. */
  time: string;
  networks: string[];
};

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "09:00" -> { h: 9, m: 0 }; anything unreadable is 9am, the planner's own default. */
export function parseTimeOfDay(value: string | null | undefined): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
  if (!m) return { h: 9, m: 0 };
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return { h, m: min };
}

/**
 * The next time that weekday comes round, as a `datetime-local` value.
 *
 * TODAY COUNTS ONLY IF IT HAS NOT PASSED. Picking "Thursday" at four in the
 * afternoon should not schedule a post for nine o'clock that morning — a time
 * in the past is refused at the door, and the person is left wondering what
 * they did wrong. So today qualifies until its slot time, and after that it
 * means next week.
 */
export function nextDayAt(day: number, time: string, now: Date = new Date()): string {
  const { h, m } = parseTimeOfDay(time);
  const target = ((Math.round(day) % 7) + 7) % 7;
  const at = new Date(now.getTime());
  at.setHours(h, m, 0, 0);
  let ahead = (target - at.getDay() + 7) % 7;
  if (ahead === 0 && at.getTime() <= now.getTime()) ahead = 7;
  at.setDate(at.getDate() + ahead);
  const pad = (n: number) => String(n).padStart(2, '0');
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + 'T' + pad(at.getHours()) + ':' + pad(at.getMinutes());
}

/** The planner's themes as a row of seven days, Monday first the way the page shows it. */
export function weekFromThemes(themes: readonly PlannerTheme[] | null | undefined): { day: number; name: string; themes: PlannerTheme[] }[] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((day) => ({
    day,
    name: DAY_NAMES[day],
    themes: (themes || []).filter((t) => (t.days || []).includes(day)),
  }));
}

/** One line for a day with no theme — it is still a day a post can go on. */
export function themeLabel(themes: readonly PlannerTheme[]): string {
  if (!themes.length) return 'No theme — 09:00';
  return themes.map((t) => t.name + ' · ' + (t.time || '09:00')).join(' · ');
}

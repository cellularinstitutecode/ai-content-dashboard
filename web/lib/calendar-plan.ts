// web/lib/calendar-plan.ts
// What the Calendar / Publishing page needs to know about the weekly planner,
// and which posts have slipped past their time.
//
// WHY. The weekly planner lived only on Templates, so the calendar showed posts
// with no sense of the plan they belonged to — nobody could look at a Wednesday
// and see "Movement 09:00 · Sleep 18:00" beside what was actually scheduled.
// And the publishing list shows "today onward" only, so a post still waiting
// for approval after its time simply vanished from it (three were sitting at
// Sep 19 on Sep 21).
//
// Pure: no imports, so the test runner reads this file directly.

export type PlanTemplate = {
  id?: string;
  name?: string;
  weekdays?: number[];
  time_of_day?: string;
  active?: boolean;
  strategy?: { mode?: string; seeded?: string } | null;
};

export type PlanEntry = { name: string; time: string; fromStrategy: boolean };

/** Active templates grouped by weekday (0 = Sunday), each day sorted by time. */
export function weeklyPlanByDay(templates: readonly PlanTemplate[] | null | undefined): Record<number, PlanEntry[]> {
  const out: Record<number, PlanEntry[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const t of templates || []) {
    if (!t || t.active === false) continue;
    const name = String(t.name || '').trim();
    if (!name) continue;
    const time = /^\d{1,2}:\d{2}/.test(String(t.time_of_day || '')) ? String(t.time_of_day).slice(0, 5) : '';
    const fromStrategy = String(t.strategy?.seeded || '') === 'weekly-strategy';
    for (const d of Array.isArray(t.weekdays) ? t.weekdays : []) {
      if (Number.isInteger(d) && d >= 0 && d <= 6) out[d].push({ name, time, fromStrategy });
    }
  }
  for (const d of Object.keys(out)) out[Number(d)].sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
  return out;
}

export type DatedPost = { publication_date?: string; status?: string };

/**
 * Posts still waiting for a decision after their publication time, oldest first.
 * `isWaiting` is passed in so this stays pure (lib/post-mode.ts owns the rule).
 */
export function overduePosts<T extends DatedPost>(posts: readonly T[], isWaiting: (status?: string) => boolean, now = Date.now()): T[] {
  return posts
    .filter((p) => p.publication_date && isWaiting(p.status) && new Date(p.publication_date).getTime() < now)
    .sort((a, b) => new Date(a.publication_date || 0).getTime() - new Date(b.publication_date || 0).getTime());
}

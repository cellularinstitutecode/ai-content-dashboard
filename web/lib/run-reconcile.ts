// web/lib/run-reconcile.ts
// What happens to the runs already planned when a template's day or time moves.
//
// WHY. planRuns only ever ADDS runs: upcomingSlots(weekdays, time) upserted on
// (template_id, scheduled_for), ignoring duplicates. So moving Tuesday's
// Nutrition slot from 09:00 to 10:00 left the 09:00 runs where they were — up
// to two of them inside the ten-day horizon, some already drafted — and added
// 10:00 runs beside them. Two Nutrition posts each Tuesday, two angles used up
// per week, and approveRun publishing the orphan at the 09:00 the operator
// believed they had removed.
//
// So on every save the future runs are measured against the template as it
// now is. One that no longer matches is removed if nothing has been spent on
// it yet (planned), and otherwise marked 'superseded' — kept, with its draft,
// but never advanced, approved, or counted in the rotation.
//
// A paused template is the same question with a simpler answer: its planned
// runs will never advance, and used to expire into red "failed" cards under
// Needs attention. Planned ones are removed; anything already written is kept
// in case it is switched back on.
//
// Pure: imports only ./timezone.ts, so the test runner reads this file directly.
import { SCHEDULE_TZ, wallClockInTz } from './timezone.ts';

/** The states a moved slot's runs can be in and still be reconciled. */
export const RECONCILABLE_STATES = ['planned', 'researched', 'drafted', 'ready_for_review'] as const;

export type ReconcileRun = {
  id: string;
  state: string;
  scheduled_for: string;
  angle?: { redatedFrom?: unknown } | null;
};

export type ReconcileTemplate = {
  weekdays?: readonly number[] | null;
  time_of_day?: string | null;
  active?: boolean | null;
};

/** Does this instant fall on one of the template's days, at its time, in the clinic's zone? */
export function slotMatches(iso: string, weekdays: readonly number[] | null | undefined, time: string | null | undefined, tz: string = SCHEDULE_TZ): boolean {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return false;
  const w = wallClockInTz(at, tz);
  const days = (weekdays || []).map((d) => Number(d));
  if (!days.includes(w.weekday)) return false;
  const [hh, mm] = String(time || '09:00').split(':').map((n) => parseInt(n, 10));
  return w.hh === (Number.isFinite(hh) ? hh : 9) && w.mm === (Number.isFinite(mm) ? mm : 0);
}

/**
 * Which future runs to remove, which to supersede.
 *
 * Never touched: past runs (expiry and the missed-post path own those),
 * terminal runs, and a run a reviewer re-dated to the next free slot — its
 * time is deliberately not the template's.
 */
export function reconcilePlan(
  runs: readonly ReconcileRun[],
  template: ReconcileTemplate,
  now: number = Date.now(),
  tz: string = SCHEDULE_TZ,
): { remove: string[]; supersede: string[] } {
  const remove: string[] = [];
  const supersede: string[] = [];
  const paused = template.active === false;
  for (const r of runs) {
    if (!r || !(RECONCILABLE_STATES as readonly string[]).includes(r.state)) continue;
    const t = new Date(r.scheduled_for).getTime();
    if (!Number.isFinite(t) || t <= now) continue;
    if (r.angle && r.angle.redatedFrom) continue;
    if (paused) {
      if (r.state === 'planned') remove.push(r.id);
      continue;
    }
    if (slotMatches(r.scheduled_for, template.weekdays, template.time_of_day, tz)) continue;
    if (r.state === 'planned') remove.push(r.id);
    else supersede.push(r.id);
  }
  return { remove, supersede };
}

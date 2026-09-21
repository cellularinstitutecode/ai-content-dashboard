// web/lib/lead-window.ts
// Whether a template's lead time can ever line up with the engine's tick.
//
// THE BUG THIS EXISTS FOR. Autopilot's cron used to fire ONCE A DAY (06:30
// UTC), and `expireStaleRuns` runs BEFORE `advanceRuns` in the same request,
// killing anything more than two hours past its slot. So a run was only ever
// workable if that single daily tick fell inside
//
//     [ scheduled_for − lead_hours , scheduled_for + 2h ]
//
// which made the floor depend on the slot's UTC time: a 09:00 Cancún slot is
// 14:00 UTC, so it needed lead ≥ 7.5h to be reached at all, and `lead_hours: 4`
// — a perfectly reasonable thing to type into a box whose minimum is 1 — meant
// the run was NEVER researched, NEVER drafted, and was marked failed every
// single morning. Forever, with a failure message blaming the slot time.
//
// WHAT CHANGED, AND WHY THIS FILE IS SMALLER FOR IT. The tick is hourly now
// (vercel.json: "0 * * * *"). Evenly spaced ticks hold the same count in a
// window of a given width wherever it sits in the day, so the slot time drops
// out of the arithmetic completely — and with it the old 8-to-19-hour floors,
// which were never about the work and only ever about catching one cron.
//
// WHAT IS LEFT IS A REAL FLOOR, and it is about the work. A run passes through
// three states to reach review, `advanceRuns` steps one run as far as its
// budget allows, and that budget is shared with up to three other runs. So the
// honest worst case is one step per tick: a lead has to be at least
// STEPS_TO_READY ticks wide for the post to be finished BEFORE its slot, and
// MAX_ATTEMPTS ticks wider than that to have anything left over for a failed
// step. Both are hours now rather than most of a day.
//
// This file is the one place that knows the cadence, so lead-window.test.ts
// asserts TICK_INTERVAL_MINUTES against vercel.json itself, and STEPS_TO_READY
// against the engine's own state list. A cron or a state edited without this
// constant would put every floor back to being quietly wrong, which is the
// failure this file was written for in the first place.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { MAX_ATTEMPTS } from './planner-constants.ts';

/** How often the engine wakes, in minutes. Mirrors vercel.json's autopilot cron. */
export const TICK_INTERVAL_MINUTES = 60;

/** How long after its slot a run survives before expireStaleRuns retires it. */
export const EXPIRY_GRACE_HOURS = 2;

/**
 * States a run passes through on its way to review: planned → researched →
 * drafted → ready_for_review. Three steps, so three ticks in the worst case
 * where each tick affords exactly one.
 *
 * Mirrors ACTIVE_STATES in lib/autopilot.ts, which is server-only and cannot be
 * imported here; the test asserts the two agree.
 */
export const STEPS_TO_READY = 3;

/** Whole hours spanned by n ticks, rounded up — the box only accepts hours. */
function tickHours(ticks: number): number {
  return Math.ceil((TICK_INTERVAL_MINUTES * ticks) / 60);
}

/**
 * The smallest lead, in whole hours, that can finish a draft before its slot.
 *
 * No longer a function of the slot time: see the header. It is the number of
 * ticks the pipeline needs, at the pessimistic rate of one step per tick.
 */
export function minimumLeadHours(): number {
  return tickHours(STEPS_TO_READY);
}

/**
 * The lead that leaves a retry budget, rather than merely enough ticks to
 * finish when nothing goes wrong.
 *
 * Deliberately NOT merged into `minimumLeadHours`: a lead below the first is
 * BROKEN (the post cannot be ready in time), while a lead below this one merely
 * has no second chance. lib/autopilot.ts sets MAX_ATTEMPTS to 2 and justifies
 * it with "an eligibility window that is only ever a couple of ticks wide" —
 * this is the lead that makes that sentence true.
 */
export function retryBudgetLeadHours(): number {
  return tickHours(STEPS_TO_READY + MAX_ATTEMPTS);
}

/**
 * Is this lead usable, and if not, what would be?
 *
 * Returns `null` when the setting is fine, so a caller can treat a truthy
 * result as the problem to report.
 */
export function leadProblem(leadHours: number): { minimum: number; message: string } | null {
  const minimum = minimumLeadHours();
  if (leadHours >= minimum) return null;
  return {
    minimum,
    message:
      'A lead of ' + leadHours + (leadHours === 1 ? ' hour' : ' hours') +
      ' is too short: the engine wakes once an hour and a post takes ' + STEPS_TO_READY +
      ' passes to research, write and score, so the slot can come round with the draft unfinished. ' +
      'Use at least ' + minimum + ' hours.',
  };
}

/**
 * Does this lead give the occurrence a second chance?
 *
 * Below this floor a single transient failure costs the whole post: `attempts`
 * stops short of MAX_ATTEMPTS, so the run is never marked failed and never
 * retried — it just quietly expires at its slot.
 */
export function retryBudgetProblem(
  leadHours: number,
): { recommended: number; message: string } | null {
  const recommended = retryBudgetLeadHours();
  if (leadHours >= recommended) return null;
  return {
    recommended,
    message:
      'A lead of ' + leadHours + (leadHours === 1 ? ' hour' : ' hours') +
      ' leaves this slot no spare passes, so one failed step loses the whole occurrence — ' +
      'it is never retried, and it is reported as having missed its time. Use at least ' + recommended +
      ' hours to give it a second attempt.',
  };
}

/**
 * The lead a template should actually be run with.
 *
 * Raising it is the right direction: preparing a draft EARLIER than asked costs
 * nothing and is invisible, whereas honouring a too-short lead produces a
 * template whose posts are reliably late.
 */
export function usableLeadHours(leadHours: number): number {
  return Math.max(leadHours, minimumLeadHours());
}

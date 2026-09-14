// web/lib/lead-window.ts
// Whether a template's lead time can ever line up with the daily tick.
//
// THE BUG THIS EXISTS FOR. Autopilot's cron fires ONCE A DAY (vercel.json:
// "30 6 * * *" = 06:30 UTC), and `expireStaleRuns` runs BEFORE `advanceRuns` in
// the same request, killing anything more than two hours past its slot. So a run
// is only ever workable if that single daily tick falls inside
//
//     [ scheduled_for − lead_hours , scheduled_for + 2h ]
//
// A 09:00 Cancún slot is 14:00 UTC. The 06:30 tick on the slot day needs
// lead ≥ 7.5h to be inside the window; by the next morning's tick the slot is
// 16.5h old and already expired. So `lead_hours: 4` — a perfectly reasonable
// thing to type into a box labelled "Prepare drafts (hours before slot)", which
// accepts a minimum of 1 — means the run is NEVER researched, NEVER drafted,
// and is marked failed every single morning. Forever. And the failure message
// blames the slot time, which is not the cause.
//
// No imports: the test runner strips types and runs this file directly.

/** When the daily cron fires, in minutes past midnight UTC. Mirrors vercel.json. */
export const TICK_UTC_MINUTES = 6 * 60 + 30;

/** How long after its slot a run survives before expireStaleRuns retires it. */
export const EXPIRY_GRACE_HOURS = 2;

/**
 * The smallest lead, in whole hours, that lets the daily tick reach a slot at
 * this UTC time.
 *
 * The tick at 06:30 must fall at or after `slot − lead`, and the slot must not
 * already be more than the grace period old. For a slot LATER in the UTC day
 * than the tick, that means the lead has to span the gap between them. For a
 * slot EARLIER in the UTC day, the previous day's tick is the one that has to
 * reach it, so the lead must span the wrap-around too.
 *
 * @param slotUtcMinutes minutes past midnight UTC of the slot.
 */
export function minimumLeadHours(slotUtcMinutes: number): number {
  const slot = ((Math.round(slotUtcMinutes) % 1440) + 1440) % 1440;
  let gap = slot - TICK_UTC_MINUTES;
  // A slot at or before the tick is reached by the tick on the SAME day only if
  // it is still inside the grace window; otherwise yesterday's tick had to have
  // covered it, which is a full day of lead away.
  if (gap < -EXPIRY_GRACE_HOURS * 60) gap += 1440;
  // A slot inside the grace window needs no lead at all — the tick that fires
  // just after it still finds it alive.
  if (gap <= 0) return 0;
  return Math.ceil(gap / 60);
}

/**
 * Is this lead usable for this slot, and if not, what would be?
 *
 * Returns `null` when the setting is fine, so a caller can treat a truthy
 * result as the problem to report.
 */
export function leadProblem(
  leadHours: number,
  slotUtcMinutes: number,
): { minimum: number; message: string } | null {
  const minimum = minimumLeadHours(slotUtcMinutes);
  if (leadHours >= minimum) return null;
  return {
    minimum,
    message:
      'A lead of ' + leadHours + (leadHours === 1 ? ' hour' : ' hours') +
      ' is too short for this slot: the daily pass runs once, and it would never fall inside the window, so every post would be marked failed the next morning. ' +
      'Use at least ' + minimum + ' hours.',
  };
}

/**
 * The lead a template should actually be saved with.
 *
 * Raising it is the right direction: preparing a draft EARLIER than asked costs
 * nothing and is invisible, whereas honouring a too-short lead produces a
 * template that silently never runs.
 */
export function usableLeadHours(leadHours: number, slotUtcMinutes: number): number {
  return Math.max(leadHours, minimumLeadHours(slotUtcMinutes));
}

/**
 * The lead that puts TWO daily ticks inside the window, not merely one.
 *
 * `minimumLeadHours` answers "can this template ever run at all" — one tick
 * inside the window. That is the floor below which a template is broken, and it
 * is not the same as the floor at which a template is RESILIENT.
 *
 * MAX_ATTEMPTS is 2, and lib/autopilot.ts justifies that number with "an
 * eligibility window that is only ever a couple of ticks wide." That assumption
 * does not hold at the default lead of 24h: a 09:00 Cancún slot is 15:00 UTC, so
 * the window opens 15:00 the day before and exactly ONE 06:30 tick falls inside
 * it. One bad morning leaves attempts at 1 — below the limit, so the run stays
 * `planned` — and no second tick ever comes, so it expires unattempted. The
 * retry budget can never be spent, and a single transient failure silently
 * costs the whole occurrence.
 *
 * A day of extra lead adds exactly one more tick. Preparing a draft earlier
 * costs nothing and is invisible; losing a week's post to one blip is not.
 */
export function twoTickLeadHours(slotUtcMinutes: number): number {
  return minimumLeadHours(slotUtcMinutes) + 24;
}

/**
 * Does this lead give the occurrence a second chance?
 *
 * Distinct from `leadProblem`, and deliberately NOT merged into it: a lead
 * below the one-tick floor is BROKEN (the template can never run), while a lead
 * below the two-tick floor merely has no retry budget. Reporting them with one
 * sentence would either overstate the first or understate the second, and the
 * caller shows them differently — a refusal versus a warning.
 */
export function retryBudgetProblem(
  leadHours: number,
  slotUtcMinutes: number,
): { recommended: number; message: string } | null {
  const recommended = twoTickLeadHours(slotUtcMinutes);
  if (leadHours >= recommended) return null;
  return {
    recommended,
    message:
      'A lead of ' + leadHours + (leadHours === 1 ? ' hour' : ' hours') +
      ' gives this slot only one daily pass to get the draft ready, so a single failed morning loses the whole occurrence — ' +
      'it is never retried, and it is reported as having missed its time. Use at least ' + recommended +
      ' hours to give it a second attempt.',
  };
}

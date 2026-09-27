// web/lib/review-queue.ts
// What the Autopilot review queue shows, and in what order.
//
// WHY. The queue route used to read "recent runs" and "failed runs of any age",
// merge them, sort the lot by slot time ascending and keep the first 20. Failed
// runs are never deleted and could not be dismissed, so after a few weeks the
// oldest failures sorted first and filled all twenty rows: every post waiting
// for approval fell off the end, and in the default human-approval mode the
// calendar stopped publishing without a word.
//
// And a post that nobody approved within a day of its slot fell out of the
// "recent" window altogether. It never expires (ready_for_review is not an
// active state), so it sat in the database, invisible and unapprovable.
//
// So the buckets are read and limited independently, the posts a person has to
// decide on come first, and a missed post is shown as missed rather than lost.
//
// Pure: no imports, so the test runner reads this file directly.

/** Failed runs older than this are history, not something to act on. */
export const FAILED_WINDOW_DAYS = 14;

/** A ready run whose slot passed this long ago is retired by the engine. */
export const MISSED_RETIRE_DAYS = 14;

/**
 * Metricool refuses a publication date in the past, and a slot a few minutes
 * away cannot be approved and reach it in time. Inside this margin the slot
 * counts as missed.
 */
export const MISSED_MARGIN_MS = 5 * 60 * 1000;

export type QueueRun = { id: string; state: string; scheduled_for: string };

export type QueueLimits = { ready: number; inFlight: number; failed: number };

export const DEFAULT_LIMITS: QueueLimits = { ready: 50, inFlight: 20, failed: 20 };

function at(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** A post that is finished and waiting, whose slot has already gone by. */
export function isMissed(run: Pick<QueueRun, 'state' | 'scheduled_for'>, now: number = Date.now()): boolean {
  return run.state === 'ready_for_review' && at(run.scheduled_for) < now + MISSED_MARGIN_MS;
}

/**
 * The queue, in the order a reviewer needs it:
 *
 *  1. posts waiting for a decision — the missed ones first (they are the
 *     urgent ones), then the upcoming ones soonest first;
 *  2. posts still being prepared, soonest first;
 *  3. failures, newest first.
 *
 * Each bucket is limited on its own, so no amount of history in one can push
 * another off the screen. A run that appears in two inputs is kept once, in
 * the first bucket that holds it.
 */
export function bucketRuns<T extends QueueRun>(
  input: { ready?: readonly T[] | null; inFlight?: readonly T[] | null; failed?: readonly T[] | null },
  now: number = Date.now(),
  limits: QueueLimits = DEFAULT_LIMITS,
): (T & { missed: boolean })[] {
  const seen = new Set<string>();
  const take = (rows: readonly T[] | null | undefined, keep: (r: T) => boolean, order: (a: T, b: T) => number, limit: number) => {
    const out = (rows || []).filter((r) => r && keep(r) && !seen.has(r.id)).slice().sort(order).slice(0, Math.max(0, limit));
    for (const r of out) seen.add(r.id);
    return out;
  };
  const asc = (a: T, b: T) => at(a.scheduled_for) - at(b.scheduled_for);
  const desc = (a: T, b: T) => at(b.scheduled_for) - at(a.scheduled_for);
  const missedFirst = (a: T, b: T) => Number(isMissed(b, now)) - Number(isMissed(a, now)) || asc(a, b);

  const ready = take(input.ready, (r) => r.state === 'ready_for_review', missedFirst, limits.ready);
  const inFlight = take(input.inFlight, (r) => r.state !== 'ready_for_review' && r.state !== 'failed', asc, limits.inFlight);
  const failed = take(input.failed, (r) => r.state === 'failed', desc, limits.failed);
  return [...ready, ...inFlight, ...failed].map((r) => ({ ...r, missed: isMissed(r, now) }));
}

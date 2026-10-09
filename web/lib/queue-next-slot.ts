// web/lib/queue-next-slot.ts
// Where a queued post whose time has passed goes when a person presses
// Reschedule on it.
//
// A post waiting for approval past its time cannot be approved: Metricool
// refuses a publication date in the past, and so does /api/posts. The button
// on such a post reads Reschedule instead of Approve, and sends
// `publication_date: NEXT_SLOT`; this picks the instant. The rule is the one
// lib/autopilot.ts applies to a missed run (lib/missed-slot.ts): the next
// quarter hour inside posting hours in the schedule's time zone, at least an
// hour clear of every other post in the queue and every Autopilot run still
// on its way. The post keeps its status — it is moved, not approved.
import { nextFreeSlot } from './missed-slot.ts';
import { SCHEDULE_TZ } from './timezone.ts';
import { reportError } from './report.ts';

/** The `publication_date` a reschedule sends to mean "the next free slot". */
export const NEXT_SLOT = 'next';

/** Rows that will never go out, so they hold no slot. */
const GONE = ['cancelled', 'canceled', 'deleted', 'failed'];
/** Runs that still have a slot on the calendar. */
const RUN_STATES = ['planned', 'researched', 'drafted', 'ready_for_review', 'approved'];
const HORIZON_DAYS = 8;

type Db = { from: (table: string) => any };

/**
 * The next free slot for post `excludeId` of `userId`, or null when the
 * queue could not be read or the next week is full. Errors are reported,
 * not thrown: the caller says "no free slot" either way.
 */
export async function nextFreeSlotFor(db: Db, userId: string, excludeId: string, now = new Date()): Promise<Date | null> {
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [posts, runs] = await Promise.all([
    db.from('posts').select('id, publication_date')
      .eq('user_id', userId)
      .not('status', 'in', '(' + GONE.join(',') + ')')
      .gte('publication_date', now.toISOString())
      .lte('publication_date', horizon)
      .limit(500),
    db.from('template_runs').select('scheduled_for')
      .eq('user_id', userId)
      .in('state', RUN_STATES)
      .gte('scheduled_for', now.toISOString())
      .lte('scheduled_for', horizon)
      .limit(500),
  ]);
  if (posts.error || runs.error) {
    reportError('posts:next-slot-read', posts.error || runs.error, { id: excludeId });
    return null;
  }
  const busy: Date[] = [
    ...((posts.data || []) as { id?: string; publication_date?: string | null }[])
      .filter((p) => String(p.id || '') !== excludeId)
      .map((p) => new Date(String(p.publication_date || ''))),
    ...((runs.data || []) as { scheduled_for?: string | null }[]).map((r) => new Date(String(r.scheduled_for || ''))),
  ].filter((d) => Number.isFinite(d.getTime()));
  return nextFreeSlot({ now, busy, tz: SCHEDULE_TZ });
}

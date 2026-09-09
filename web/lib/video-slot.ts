// web/lib/video-slot.ts
// When an automatically prepared video should be scheduled for.
//
// Metricool needs a publication time, and nothing in the sheet supplies one —
// so the sweep has to choose. The rule is deliberately dull: the next weekday
// morning, one video per slot, never two in the same slot.
//
// One video per slot is the part that matters. Working off a backlog of thirty
// rows would otherwise stack thirty posts on one morning, which is not a
// content calendar — it is a burst that reads as spam on every network and
// that a person then has to unpick by hand in Metricool.
//
// Pure, so it is unit-tested; lib/video-autopilot.ts supplies the real clock
// and the slots already taken.
import { upcomingSlots } from './timezone.ts';

/** Monday–Friday. The clinic does not post at weekends. */
export const POST_WEEKDAYS = [1, 2, 3, 4, 5];

/** Clinic morning. Matches the Video Library composer's own default. */
export const POST_TIME_OF_DAY = process.env.VIDEO_AUTOPILOT_TIME || '09:00';

/** How far ahead a backlog may be spread before it is somebody's decision, not this rule's. */
const HORIZON_DAYS = 120;

/**
 * The next free posting slot.
 *
 * @param taken ISO instants already scheduled (from the posts table)
 * @param now   the current instant
 * @returns the slot as a UTC instant, or null if the horizon is genuinely full
 */
export function nextFreeSlot(taken: Iterable<string>, now: Date = new Date(), tz?: string): Date | null {
  const used = new Set<number>();
  for (const t of taken) {
    const at = Date.parse(String(t));
    if (Number.isFinite(at)) used.add(at);
  }
  const slots = upcomingSlots(POST_WEEKDAYS, POST_TIME_OF_DAY, HORIZON_DAYS, tz, now);
  for (const slot of slots) {
    if (!used.has(slot.getTime())) return slot;
  }
  return null;
}

/**
 * Which networks to draft for, given the row's ticks and whether the video can
 * be fetched by Metricool.
 *
 * The sheet's checkboxes are the clinic's own intent for that video and are
 * followed where they are set. Where a row says nothing — most new rows do —
 * LinkedIn is the default, because it is the one network whose post is
 * complete without a video file attached.
 *
 * A network that needs a video is dropped when there is no fetchable URL for
 * one, rather than drafted empty: a TikTok post with no video is not a draft a
 * person can approve, it is a chore.
 */
export const NEEDS_VIDEO = new Set(['tiktok', 'instagram', 'youtube']);

export function networksFor(ticked: readonly string[], hasVideoUrl: boolean): string[] {
  const wanted = (ticked || []).map((n) => String(n || '').toLowerCase()).filter(Boolean);
  const chosen = wanted.length ? wanted : ['linkedin'];
  const out = chosen.filter((n) => (NEEDS_VIDEO.has(n) ? hasVideoUrl : true));
  // Email is a column in the sheet, not a social network Metricool posts to.
  return Array.from(new Set(out.filter((n) => n !== 'email')));
}

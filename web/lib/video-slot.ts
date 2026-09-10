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
 * N distinct slots, taken in one go.
 *
 * nextFreeSlot answers for ONE post against a calendar read a moment ago, which is
 * correct for a single Prepare and wrong for several running at once: concurrent runs all
 * read the calendar before any of them writes, so every one of them picks the same
 * morning and the batch stacks on a single instant — exactly what one-post-per-slot
 * exists to prevent, and exactly what a person then unpicks by hand in Metricool.
 *
 * So a batch reserves its slots before it starts, from one reading, and hands each row
 * the slot it already owns.
 *
 * Returns fewer than `count` when the scheduling horizon runs out; the caller decides
 * whether that is a reason to stop or to send the rest without a time.
 */
export function reserveSlots(count: number, taken: Iterable<string>, now: Date = new Date(), tz?: string): Date[] {
  const used = new Set<string>();
  for (const t of taken) {
    const at = Date.parse(String(t));
    if (Number.isFinite(at)) used.add(new Date(at).toISOString());
  }
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    const slot = nextFreeSlot(used, now, tz);
    if (!slot) break;
    out.push(slot);
    // Claim it against the rest of this batch, not merely against the calendar.
    used.add(slot.toISOString());
  }
  return out;
}

/**
 * Which networks to draft for, given the row's ticks and whether the video can
 * be fetched by Metricool.
 *
 * The sheet's checkboxes are the clinic's own intent for that video and are
 * followed where they are set. Where a row says nothing — which is most rows —
 * all three of the clinic's video destinations are chosen.
 *
 * The default used to be LinkedIn alone, on the reasoning that it is the one
 * network whose post is complete without a video attached. That was true and
 * beside the point: nobody ticks the boxes, so in practice every prepared
 * video went to exactly one network and the other two were never reached. A
 * default is what the thing does, not a fallback nobody was meant to hit.
 *
 * A network that needs a video is still dropped when there is no fetchable URL
 * for one, rather than drafted empty: a TikTok post with no video is not a
 * draft a person can approve, it is a chore.
 */
export const NEEDS_VIDEO = new Set(['tiktok', 'instagram', 'youtube']);

/** Where a video goes when the row does not say otherwise. */
export const DEFAULT_VIDEO_NETWORKS = ['youtube', 'linkedin', 'tiktok'];

/**
 * Networks that only make sense for a portrait video.
 *
 * TikTok is a vertical feed; a 16:9 video posted there is letterboxed or
 * cropped through the middle of whatever it was framing. YouTube is
 * deliberately absent — landscape is the normal shape of a YouTube video, and
 * only its Shorts shelf wants portrait.
 */
const VERTICAL_ONLY = new Set(['tiktok']);

/**
 * Does this video's shape suit this network?
 *
 * Read from the sheet's FORMATO column, which the clinic already fills in with
 * "Vertical 9:16" or "Horizontal 16:9". An unreadable or empty format is
 * treated as fine: the column is a human note, and refusing to post because
 * somebody left a cell blank would be the tool inventing a rule.
 */
export function fitsAspect(network: string, format: string | null | undefined): boolean {
  if (!VERTICAL_ONLY.has(String(network || '').toLowerCase())) return true;
  return !/horizontal|16\s*[:x/]\s*9|landscape|paisaje/i.test(String(format || ''));
}

export function networksFor(ticked: readonly string[], hasVideoUrl: boolean, format?: string | null): string[] {
  const wanted = (ticked || []).map((n) => String(n || '').toLowerCase()).filter(Boolean);
  const chosen = wanted.length ? wanted : DEFAULT_VIDEO_NETWORKS;
  const out = chosen
    .filter((n) => (NEEDS_VIDEO.has(n) ? hasVideoUrl : true))
    // Only applied when a format was actually supplied, so every existing
    // caller keeps its behaviour until it opts in by passing one.
    .filter((n) => (format === undefined ? true : fitsAspect(n, format)));
  // Email is a column in the sheet, not a social network Metricool posts to.
  return Array.from(new Set(out.filter((n) => n !== 'email')));
}

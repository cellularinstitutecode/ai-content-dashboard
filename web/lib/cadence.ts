// web/lib/cadence.ts
// How much this account publishes in a week, and therefore how far back the
// repetition guards have to look to see the last time a slot came round.
//
// WHY THIS IS A CALCULATION AND NOT A NUMBER. lib/recent-openers.ts looked back
// over the last 12 drafts, which was a comfortable fortnight when the only
// thing publishing was a pair of reels a few days a week. The weekly content
// strategy adds fourteen posts a week on top of that, and 12 drafts stopped
// being a fortnight — it became roughly half a day. A guard that cannot see
// last Monday when Monday comes round again is a guard that has been switched
// off, quietly, by a cadence change somewhere else in the codebase.
//
// So the window is derived from the cadence rather than typed in beside it: add
// a slot to the strategy or a third reel to the day and the window widens with
// it.
//
// Pure: the test runner reads this file directly.
import { POSTS_PER_WEEK } from './content-strategy.ts';
import { DEFAULT_POST_TIMES } from './video-slot.ts';

/** Reels a day, by the sweep's own default slot list ("two a day"). */
export const VIDEO_SLOTS_PER_DAY = DEFAULT_POST_TIMES.length;

/** Reels a week, if every slot on every day is filled — the worst case, which is the one the window must survive. */
export const VIDEO_POSTS_PER_WEEK = VIDEO_SLOTS_PER_DAY * 7;

/**
 * Drafts written in a full week: the strategy's fourteen plus the reels.
 *
 * `drafts` is the table the opening-line guard reads, and every one of these
 * writes a row into it, so this is the right unit — not "posts", which counts
 * one draft once per network.
 */
export const DRAFTS_PER_WEEK = POSTS_PER_WEEK + VIDEO_POSTS_PER_WEEK;

/** Never look back over fewer rows than the guard managed before this file existed. */
export const MIN_LOOK_BACK = 12;

/**
 * A ceiling, because this number becomes a row limit on a jsonb column.
 *
 * Each row carries a whole generated pack. A cadence constant edited somewhere
 * else should widen the window, not turn one guard into the slowest query in
 * the request.
 */
export const MAX_LOOK_BACK = 120;

/**
 * How many recent drafts the opening-line guard should read.
 *
 * Two weeks by default rather than one: a pillar returns weekly, so a one-week
 * window sees the previous occurrence only if nothing else was published in
 * between — and something always is.
 */
export function openingLookBack(weeks = 2): number {
  const wanted = Math.ceil(DRAFTS_PER_WEEK * Math.max(0, weeks));
  return Math.min(MAX_LOOK_BACK, Math.max(MIN_LOOK_BACK, wanted));
}

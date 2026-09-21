// web/lib/weekly-pace.ts
// How many posts this account may have going out in any seven consecutive days.
//
// WHY THIS EXISTS, AND WHY NOW. Until this week the engine woke once a day and
// stopped at ready_for_review, so the ceiling on what it could publish was a
// person with a mouse. Both of those are gone: the tick is hourly, and with
// AUTOPILOT_AUTOSCHEDULE on the engine presses its own Approve. Nothing else in
// the pipeline counts. Every guard upstream asks whether ONE post is fit to go
// — the compliance gate, the video rule, lib/autoschedule.ts — and a calendar
// that has quietly doubled passes every one of them fifteen extra times.
//
// And the calendar CAN quietly double. `schedule_templates` has no unique key
// beyond its id; the seed route is idempotent only because it marks its own
// rows and reads them back first, and an audit of that route found two separate
// ways it could write a second set of fifteen. A backstop that does not depend
// on any of that being right is worth more than another careful read of it.
//
// WHAT IT BINDS. The engine only. A person pressing Approve has looked at the
// post, and this ceiling exists precisely to stand in for that person when
// nobody is looking — refusing them their own button would be a guard arguing
// with the thing it is a substitute for. So this is checked inside autoSchedule
// and nowhere else, and a held run says so on its card and waits for a human,
// exactly as it did before the setting was turned on.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { DRAFTS_PER_WEEK } from './cadence.ts';

/** The window. Seven consecutive days, sliding — not Monday-to-Sunday. */
export const ROLLING_WINDOW_DAYS = 7;

const WINDOW_MS = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The ceiling, derived from the cadence rather than typed beside it.
 *
 * DRAFTS_PER_WEEK is the strategy's fourteen slots, the weekly article, and the
 * reels at their WORST CASE of every slot on every day filled. Real weeks carry
 * far fewer reels than that, so the slack is generous for an ordinary week and
 * still well under a doubled calendar — thirty social posts trips it, a normal
 * fifteen plus a busy fortnight of reels does not.
 *
 * Add a slot to the strategy and this widens with it, which is the whole reason
 * lib/cadence.ts exists.
 *
 * IT IS COUNTED IN DRAFTS, and so is everything measured against it — see
 * ScheduledPost.draft_id. Reading it as "rows in `posts`" made a fourteen-reel
 * week forty-two, and held every engine post on a perfectly ordinary week.
 */
export const WEEKLY_CEILING = DRAFTS_PER_WEEK;

/** Rows scanned around the slot before the count stops being trustworthy. */
export const PACE_SCAN_LIMIT = 500;

/**
 * Statuses that mean a `posts` row is NOT going out on its own.
 *
 * 'pending_review' is what a draft approval and the video sweep write: those
 * rows wait for somebody, so counting them would hold real posts for the sake
 * of ones that may never publish. Anything unrecognised counts, because an
 * unknown status is not evidence that a post is inert.
 */
export const NOT_PUBLISHING: ReadonlySet<string> = new Set([
  'pending_review',
  'draft',
  'cancelled',
  'canceled',
  'deleted',
  'failed',
]);

/** Does this row represent something that will publish by itself? */
export function counts(status?: string | null): boolean {
  return !NOT_PUBLISHING.has(String(status ?? '').trim().toLowerCase());
}

export type ScheduledPost = {
  publication_date?: string | number | Date | null;
  status?: string | null;
  /**
   * THE UNIT. One draft going to three networks is ONE post by any human
   * reading of the word, and it is one row in `drafts` — but the video sweep
   * writes a `posts` row PER NETWORK (lib/video-publish.ts), so counting rows
   * counts it three times.
   *
   * The first version of this file did exactly that, against a ceiling
   * expressed in drafts, and lib/cadence.ts says in as many words that `posts`
   * is the wrong unit because it "counts one draft once per network". A week of
   * reels is 14 videos and 42 rows; the ceiling is 29. Every engine post would
   * have been held, on an ordinary week, with a message blaming a full calendar.
   */
  draft_id?: string | null;
  /** Falls back to this when a row has no draft, so such rows still count once each. */
  id?: string | null;
};

export type PaceVerdict =
  | { ok: true; count: number; ceiling: number }
  | { ok: false; count: number; ceiling: number; message: string };

/**
 * Read AUTOPILOT_WEEKLY_CEILING, or fall back to the derived number.
 *
 * Unset, misspelt, zero or negative all leave the default in place. There is no
 * value that removes the ceiling: somebody who wants the engine publishing
 * without one can turn AUTOPILOT_AUTOSCHEDULE off and approve by hand, which is
 * the same amount of work and involves reading the posts.
 */
export function weeklyCeiling(raw?: string | null): number {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n < 1) return WEEKLY_CEILING;
  return Math.floor(n);
}

/**
 * What makes two `posts` rows the same post.
 *
 * The draft, when there is one: a reel fanned out to YouTube, LinkedIn and
 * TikTok is three rows sharing one `draft_id`, and it is one post. Failing
 * that the row's own id, so a row with no draft still counts once. Failing
 * even that, its position, so two unidentifiable rows are never silently
 * merged into one — this guard undercounting is the failure that matters.
 */
function keyOf(row: ScheduledPost, index: number): string {
  const draft = typeof row.draft_id === 'string' ? row.draft_id.trim() : '';
  if (draft) return 'draft:' + draft;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (id) return 'row:' + id;
  return 'pos:' + index;
}

function at(value: string | number | Date | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * May one more post join this week?
 *
 * THE WINDOW IS NOT "THE WEEK THE SLOT IS IN". A calendar week boundary is an
 * arbitrary place to reset a limit — fourteen posts on Sunday and fourteen on
 * Monday is twenty-eight posts in two days and passes any Monday-to-Sunday
 * count. So this asks the question that actually matters: across EVERY seven
 * consecutive days that would contain this post, what is the worst count? Only
 * windows starting at an existing post can be the worst one, so enumerating
 * those is exact rather than approximate.
 *
 * `count` is that worst window, the candidate included, and it is reported
 * whether or not the post may go — a card that says "26 of 29" is worth more
 * than one that says nothing until the day it refuses.
 */
export function weeklyPaceVerdict(input: {
  slot: string | number | Date;
  scheduled: readonly (ScheduledPost | null | undefined)[];
  ceiling?: number;
  /** The scan hit PACE_SCAN_LIMIT, so `scheduled` is not the whole picture. */
  truncated?: boolean;
}): PaceVerdict {
  const ceiling = Number.isFinite(input.ceiling) && (input.ceiling as number) >= 1
    ? Math.floor(input.ceiling as number)
    : WEEKLY_CEILING;

  const slot = at(input.slot);
  if (slot == null) {
    // Fail closed, like every other decision the engine makes on its own. An
    // unreadable slot is not permission to publish.
    return {
      ok: false,
      count: 0,
      ceiling,
      message: 'Held because this occurrence has no readable time, so there is no way to tell what week it belongs to.',
    };
  }

  if (input.truncated) {
    return {
      ok: false,
      count: PACE_SCAN_LIMIT,
      ceiling,
      message:
        'Held because there are more than ' + PACE_SCAN_LIMIT + ' posts on the calendar around this slot — ' +
        'far past the ' + ceiling + ' a week this account sends unattended, and more than this check can count. ' +
        'Worth looking at the calendar before anything else goes out.',
    };
  }

  // The candidate keeps a key of its own rather than borrowing its draft's.
  // A `posts` row already existing for this run's draft would mean a double
  // send, which rescueStrandedApprovals handles; collapsing them here would
  // quietly hide it, and counting one extra errs toward holding.
  const points: { at: number; key: string }[] = [{ at: slot, key: '\u0000candidate' }];
  let index = 0;
  for (const row of input.scheduled || []) {
    index++;
    if (!row) continue;
    if (!counts(row.status)) continue;
    const t = at(row.publication_date);
    if (t == null) continue;
    // Too far either side to share a seven-day window with the candidate.
    if (Math.abs(t - slot) >= WINDOW_MS) continue;
    points.push({ at: t, key: keyOf(row, index) });
  }
  points.sort((a, b) => a.at - b.at);

  let worst = 0;
  for (const start of points) {
    if (start.at > slot) break; // a window opening after the candidate cannot hold it
    if (slot - start.at >= WINDOW_MS) continue; // nor one that closes before it
    // DISTINCT drafts, not rows — see ScheduledPost.draft_id. A reel's three
    // network rows are one post.
    const seen = new Set<string>();
    for (const p of points) if (p.at >= start.at && p.at - start.at < WINDOW_MS) seen.add(p.key);
    if (seen.size > worst) worst = seen.size;
  }

  if (worst > ceiling) {
    return {
      ok: false,
      count: worst,
      ceiling,
      message:
        'Held because sending this would make ' + worst + ' posts in seven days, past the ' + ceiling +
        ' a week this account sends unattended. Nothing is lost — approve it yourself if the week really should carry it, ' +
        'or check the calendar for duplicate templates.',
    };
  }

  return { ok: true, count: worst, ceiling };
}

/** The line that goes on the run's card. '' when it may go. */
export function paceNote(verdict: PaceVerdict): string {
  return verdict.ok ? '' : verdict.message;
}

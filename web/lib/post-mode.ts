// Whether a post may go out — the single rule behind every replace this app
// sends to Metricool, kept here so it has one home and one test.
//
// A replace carries draft/autoPublish flags, so this answer decides whether
// MOVING a post publishes it. The two ways to be wrong are not equally bad:
//
//   say review when it is live  → the post drops back into the review queue
//                                 and somebody presses Approve again. Visible,
//                                 recoverable, annoying.
//   say live when it is review  → the post goes out with nobody's approval.
//                                 Not recoverable, and not visible until it is.
//
// So exactly one value counts as live, and it is a word only the approve path
// ever writes.
import type { PostMode } from './metricool-post.ts';
import { videoVerdict, type PackLike } from './video-required.ts';

/** The one status that means a person read this post and said yes. */
export const APPROVED_STATUS = 'approved';

/**
 * Which Metricool queue a post belongs in, from our own status column.
 *
 * Deliberately NOT 'scheduled'. That value arrives two ways that have nothing
 * to do with anybody approving anything: it is the DEFAULT on posts.status in
 * schema.sql, and it is Metricool's own word for a post sitting in its REVIEW
 * queue, which /api/metricool/schedule used to copy onto our row verbatim.
 */
export function modeOfStatus(status: unknown): PostMode {
  return String(status || '').toLowerCase() === APPROVED_STATUS ? 'scheduled' : 'review';
}

/** Is this post still waiting for a person? Drives the Approve buttons. */
export function isAwaitingApproval(status: unknown): boolean {
  const s = String(status || '').toLowerCase();
  if (s === APPROVED_STATUS) return false;
  return !['published', 'sent', 'live', 'failed', 'error', 'rejected'].includes(s);
}

/**
 * Is this post waiting on its video?
 *
 * The third question every screen asks about a post, beside "which queue" and
 * "is a person still owed a look". It lives here rather than in each page for
 * the reason the other two do: `app/calendar/page.tsx` already carried its own
 * sloppier copy of the status wording, and two copies of a rule that gates
 * publishing is one copy too many.
 *
 * `pack` is the linked draft's pack, or null when a post has no draft — a
 * hand-written post is never video-derived, so null is simply "no". `hasVideo`
 * is `posts.media_drive_file_id`, the only column that ever holds a video.
 *
 * Narrowed to posts a person could still act on. A post already approved or
 * published has had its answer; painting PENDING on it would say the opposite
 * of what happened.
 */
export function videoPending(status: unknown, pack: PackLike, hasVideo: boolean): boolean {
  if (!isAwaitingApproval(status)) return false;
  return videoVerdict(pack, hasVideo).pending;
}

/** How a status reads on screen, and the colour that goes with it. */
export type PostStatusMeta = { label: string; tone: 'green' | 'red' | 'amber' | 'blue' };

/**
 * The words a person sees for a post's status.
 *
 * Here, not on a page, because there were three copies and they disagreed.
 * `app/page.tsx` asked isAwaitingApproval and offered the Approve button off
 * the result; `app/calendar/page.tsx` had a shorter one that fell through to
 * "Scheduled" for everything it did not recognise — including 'pending_review',
 * so on the calendar a post nobody had approved read as scheduled to go out.
 *
 * The label decides whether Approve is offered, so it has to ask exactly the
 * question the API asks before it sends anything. 'scheduled' is not an
 * approval: it is the column default in schema.sql and Metricool's own word for
 * a post it is merely HOLDING for review.
 */
export function postStatusMeta(status: unknown): PostStatusMeta {
  const s = String(status || '').toLowerCase();
  if (s === 'published' || s === 'sent' || s === 'live') return { label: 'Published', tone: 'green' };
  if (s === 'failed' || s === 'error' || s === 'rejected') return { label: 'Needs attention', tone: 'red' };
  return isAwaitingApproval(s)
    ? { label: 'Waiting for your approval', tone: 'amber' }
    : { label: 'Scheduled', tone: 'blue' };
}

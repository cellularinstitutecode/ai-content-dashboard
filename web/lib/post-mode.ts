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

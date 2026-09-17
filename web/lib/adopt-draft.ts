// web/lib/adopt-draft.ts
// A draft already waiting for this video is the draft you continue.
//
// THE WALL. The send door asked "does this video already have a draft waiting
// on this network?" and, when the answer was yes, returned 409 and stopped.
// That question is worth asking — it is the only reason one row stopped
// reaching Metricool eleven times — but the ANSWER was wrong. The right answer
// to "there is already a draft for this" is not "go away", it is "then this is
// that draft". Sending updates it.
//
// So the same lookup now produces one of three decisions instead of a refusal:
//
//   create  nothing is waiting on this network — post it, as before
//   update  a draft is waiting — replace it, so the copy, the time and the
//           settings become whatever was just sent
//   refuse  it has already been PUBLISHED on this network. That wall stays:
//           rewriting a post the world has already seen is a different act,
//           and one nobody asked for.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { hasGoneOut, networkOf, type AwaitingLike } from './queue-guard.ts';
import { isAwaitingApproval } from './post-mode.ts';

/** A post as the adoption lookup needs to see it. */
export type AdoptablePost = AwaitingLike & {
  id?: unknown;
  /** Metricool's own id for the draft. Without it there is nothing to replace. */
  metricool_post_id?: unknown;
};

export type AdoptDecision =
  | { action: 'create' }
  | { action: 'update'; postId: string; metricoolPostId: string }
  | { action: 'refuse'; reason: 'already_published' };

function idOf(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * What should sending this video to this network do?
 *
 * `posts` is every post already known for the video — the result of
 * awaitingPostsForVideo. `network` is the one being sent right now.
 */
export function decideAdoption(posts: readonly AdoptablePost[], network: string): AdoptDecision {
  const want = String(network || '').trim().toLowerCase();
  if (!want) return { action: 'create' };

  const mine = posts.filter((p) => networkOf(p) === want);

  // Published beats everything, even when a draft is waiting beside it: the
  // reel has gone out on this network and sending it again is the duplicate
  // publish this guard exists to prevent.
  if (mine.some((p) => hasGoneOut(p.status))) return { action: 'refuse', reason: 'already_published' };

  for (const p of mine) {
    if (!isAwaitingApproval(p.status)) continue;
    const postId = idOf(p.id);
    const metricoolPostId = idOf(p.metricool_post_id);
    // A waiting row with no Metricool id is a post that never reached
    // Metricool — a half-finished send. There is nothing to replace there, so
    // it is created instead. Never a silent no-op: the alternative is a press
    // of Send that reports success and changes nothing anywhere.
    if (postId && metricoolPostId) return { action: 'update', postId, metricoolPostId };
  }

  return { action: 'create' };
}

/**
 * Did the replace fail because the draft is no longer there?
 *
 * Metricool answers 404 to a PUT at a post id it does not have, which happens
 * for two ordinary reasons: the draft was deleted in Metricool directly — which
 * is exactly what clearing duplicates by hand does — or the post belongs to a
 * different brand than the one being sent to, so the id is not found in THIS
 * blog. Either way our row is stale, and the send should create rather than
 * dead-end.
 *
 * Narrow on purpose. A rejected body (400), a refused credential (401/403), a
 * rate limit (429) or an outage (5xx) must NEVER be retried as a create: the
 * post may well exist, and creating a second one is how the duplicates this
 * whole guard exists to prevent get made.
 */
export function replaceMissing(status: unknown): boolean {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  return code === 404 || code === 410;
}

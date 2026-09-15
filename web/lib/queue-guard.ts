// web/lib/queue-guard.ts
// One draft per video and network, while it waits for approval.
//
// THE DUPLICATES. Four paths create Metricool drafts for a video — the sweep
// (two branches), the Prepare button, the Attach videos button and the
// composer — and none of them asked whether the video already had a draft
// waiting on that network. Row 179 ended up in Metricool eleven times. The
// rule below is applied at the hand-off every video path goes through, and
// in the composer route: a network that already has a draft awaiting
// approval for this video is skipped, and the caller is told so.
//
// Pure: the reads are the caller's; this only decides.
import { isAwaitingApproval } from './post-mode.ts';

export type AwaitingLike = {
  providers?: unknown;
  status?: unknown;
};

/** The network of a post, as the queue names it: the first provider, lowercased. */
export function networkOf(post: AwaitingLike): string {
  const list = Array.isArray(post.providers) ? post.providers : [];
  return String(list[0] ?? '').trim().toLowerCase();
}

/**
 * Split the networks a caller wants into those that already have a draft
 * awaiting approval for this video (skip) and those that do not (send).
 */
export function networksAlreadyQueued(posts: readonly AwaitingLike[], networks: readonly string[]): { queued: string[]; free: string[] } {
  const waiting = new Set<string>();
  for (const p of posts) {
    if (!isAwaitingApproval(p.status)) continue;
    const n = networkOf(p);
    if (n) waiting.add(n);
  }
  const queued: string[] = [];
  const free: string[] = [];
  for (const n of networks) {
    const key = String(n || '').trim().toLowerCase();
    if (!key) continue;
    (waiting.has(key) ? queued : free).push(n);
  }
  return { queued, free };
}

/** The sentence a skipped network gets, with the row when it is known. */
export function alreadyQueuedMessage(network: string, rowLabel?: string | null): string {
  const where = rowLabel ? rowLabel + ' already has' : 'This video already has';
  return where + ' a ' + network + ' draft waiting for your approval — approve it in the queue, or delete it there first.';
}

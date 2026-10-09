// web/lib/metricool-state.ts
// What Metricool says a post is, and what that makes our row.
//
// The queue used to be a one-way street: a post's status was written here
// when it was sent for review, and nothing ever read Metricool's answer
// back. So a post approved in Metricool's own planner, or one Metricool had
// already PUBLISHED, still wore its Approve button here — and a person could
// not tell what had gone out without opening Metricool. These two functions
// are the way back: read the state off Metricool's post object, then decide
// what our status column should say.
//
// Pure, so the runner reads it directly. The post object's shape is not
// pinned down in public documentation, so the reader accepts every spelling
// it has been seen in: a top-level `status`, a `draft` flag (the one this app
// writes), and each provider's own `status` (the one app/api/assistant/route.ts
// already copied). Unknown shapes answer 'unknown', and 'unknown' changes
// nothing.
import { APPROVED_STATUS, isAwaitingApproval } from './post-mode.ts';

export type RemoteState = 'review' | 'scheduled' | 'published' | 'failed' | 'unknown';

const PUBLISHED = new Set(['PUBLISHED', 'SENT', 'LIVE']);
const FAILED = new Set(['ERROR', 'ERRORS', 'FAILED', 'FAILURE', 'REJECTED', 'WITH_ERRORS']);
const SCHEDULED = new Set(['PENDING', 'SCHEDULED', 'QUEUED', 'PUBLISHING']);
const DRAFT = new Set(['DRAFT', 'REVIEW', 'PENDING_REVIEW']);

function word(x: unknown): string {
  return typeof x === 'string' ? x.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
}

/** Every status word on the post: its own, and each network's. */
function statusWords(post: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['status', 'publicationStatus', 'state']) out.push(word(post[k]));
  const providers = Array.isArray(post.providers) ? post.providers : [];
  for (const p of providers) {
    if (p && typeof p === 'object') {
      const r = p as Record<string, unknown>;
      for (const k of ['status', 'publicationStatus', 'state']) out.push(word(r[k]));
    }
  }
  return out.filter(Boolean);
}

function publishedUrl(post: Record<string, unknown>): boolean {
  if (post.publishedUrl || post.publishedAt || post.published === true) return true;
  const providers = Array.isArray(post.providers) ? post.providers : [];
  return providers.some((p) => p && typeof p === 'object' && Boolean((p as Record<string, unknown>).publishedUrl || (p as Record<string, unknown>).publishedAt));
}

/** Metricool's envelope, unwrapped: {data: post} or the post itself. */
export function unwrapPost(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const inner = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : r;
  return inner;
}

/**
 * The state Metricool's post object describes.
 *
 *   published  it went out on at least one network (a published URL, or a
 *              network whose status says so). Wins over everything: a post
 *              that is out is out, whatever its draft flag still says.
 *   failed     a network reported an error and none published.
 *   review     Metricool holds it as a draft — nobody has approved it there.
 *   scheduled  it is in the live queue, waiting for its time.
 *   unknown    none of the above could be read.
 */
export function remoteStateOf(raw: unknown): RemoteState {
  const post = unwrapPost(raw);
  if (!post) return 'unknown';
  const words = statusWords(post);
  if (publishedUrl(post) || words.some((w) => PUBLISHED.has(w))) return 'published';
  if (words.some((w) => FAILED.has(w))) return 'failed';
  // The flag this app writes is the surest sign of which queue it is in.
  if (post.draft === true) return 'review';
  if (post.draft === false) return 'scheduled';
  if (words.some((w) => DRAFT.has(w))) return 'review';
  if (words.some((w) => SCHEDULED.has(w)) || post.autoPublish === true) return 'scheduled';
  return 'unknown';
}

/**
 * The status our row should carry given what Metricool said, or null when
 * it already says the right thing (or Metricool said nothing readable).
 *
 * The one direction that must never be guessed is "live when it is review"
 * (lib/post-mode.ts): so a post Metricool holds as a draft is put back to
 * waiting even if our row said approved, and a post Metricool has in its
 * live queue is marked approved — a person approved it there, and the
 * Approve button here would otherwise offer to do it again.
 */
export function reconcileStatus(local: unknown, remote: RemoteState): string | null {
  const s = String(local || '').toLowerCase();
  switch (remote) {
    case 'published': return s === 'published' ? null : 'published';
    case 'failed': return s === 'failed' || s === 'published' ? null : 'failed';
    case 'scheduled': return isAwaitingApproval(s) ? APPROVED_STATUS : null;
    case 'review': return s === APPROVED_STATUS ? 'pending_review' : null;
    default: return null;
  }
}

/** Metricool's list answer, whatever it is wrapped in, keyed by post id. */
export function indexByPostId(raw: unknown): Map<string, Record<string, unknown>> {
  const r = raw as Record<string, unknown> | unknown[] | null;
  const list: unknown[] = Array.isArray(r) ? r
    : r && typeof r === 'object' && Array.isArray((r as Record<string, unknown>).data) ? ((r as Record<string, unknown>).data as unknown[])
    : r && typeof r === 'object' && Array.isArray((r as Record<string, unknown>).posts) ? ((r as Record<string, unknown>).posts as unknown[])
    : r && typeof r === 'object' && Array.isArray((r as Record<string, unknown>).items) ? ((r as Record<string, unknown>).items as unknown[])
    : [];
  const out = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    const post = unwrapPost(item);
    if (!post) continue;
    const id = post.id ?? post.postId;
    if (id == null || id === '') continue;
    out.set(String(id), post);
  }
  return out;
}

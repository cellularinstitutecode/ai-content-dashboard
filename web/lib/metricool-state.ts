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
const DRAFT = new Set(['DRAFT', 'REVIEW', 'PENDING_REVIEW']);
// NOT a queue: Metricool answers PENDING on a post this app created with
// draft:true (app/api/assistant/route.ts stored exactly that), so the word
// says "not yet out", not "approved". Only the draft flag tells the queues
// apart; a status word alone never marks a post approved.

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
 *   scheduled  it is in the live queue (draft:false / autoPublish:true),
 *              waiting for its time. A bare PENDING is not this.
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
  if (post.autoPublish === true) return 'scheduled';
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

/** The first array of objects in the answer, up to two envelopes deep ({data:[...]}, {data:{posts:[...]}}). */
export function postList(raw: unknown, depth = 0): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object' || depth > 2) return [];
  const r = raw as Record<string, unknown>;
  for (const k of ['data', 'posts', 'items', 'content', 'list', 'results']) {
    if (k in r) {
      const found = postList(r[k], depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

/** Metricool's list answer, whatever it is wrapped in, keyed by post id. */
export function indexByPostId(raw: unknown): Map<string, Record<string, unknown>> {
  const list = postList(raw);
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

/**
 * One line about what Metricool answered, for the provider-status record
 * (lib/provider-status.ts): how many posts, the keys of one, and the fields
 * the reader looks at — never the text. This is how the contract gets
 * learned from a real answer instead of guessed.
 */
export function describeAnswer(raw: unknown): string {
  const list = postList(raw);
  const first = unwrapPost(list[0]);
  if (!first) {
    const r = raw && typeof raw === 'object' ? Object.keys(raw as object).slice(0, 8).join(',') : typeof raw;
    return 'queue: 0 posts (top-level: ' + r + ')';
  }
  const providers = Array.isArray(first.providers) ? first.providers : [];
  const p0 = providers[0] && typeof providers[0] === 'object' ? (providers[0] as Record<string, unknown>) : {};
  return 'queue: ' + list.length + ' posts; keys=' + Object.keys(first).slice(0, 14).join(',')
    + '; draft=' + String(first.draft) + ' autoPublish=' + String(first.autoPublish) + ' status=' + String(first.status ?? '')
    + '; provider keys=' + Object.keys(p0).slice(0, 8).join(',') + ' status=' + String(p0.status ?? '')
    + '; state=' + remoteStateOf(first);
}

/**
 * The `start` / `end` of a scheduler list, as Metricool wants them. A bare
 * date is refused: "Invalid value '2026-09-25'. Valid format is: date-time
 * in format yyyy-MM-dd'T'HH:mm:ss" (its 400, recorded by the queue read).
 * Local wall-clock digits with no zone, which is what the error describes.
 */
export function metricoolDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

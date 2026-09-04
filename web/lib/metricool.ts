// Server-only Metricool client.
// Docs: https://app.metricool.com/resources/apidocs/index.html
// Base: https://app.metricool.com/api  |  Auth header: X-Mc-Auth: <userToken>

import { formatForMetricool, SCHEDULE_TZ } from '@/lib/timezone';
import { modeFlags, replacePostBody, type PostMode, type ReplacePostInput } from '@/lib/metricool-post';
export { modeFlags, replacePostBody, type PostMode, type ReplacePostInput };

export type Provider =
  | 'instagram' | 'facebook' | 'twitter' | 'linkedin'
  | 'tiktok' | 'youtube' | 'gmb' | 'pinterest' | 'threads'
  | 'bluesky';

export interface SchedulePostInput {
  text: string;
  providers: Provider[];
  // UTC instant (ISO string); converted to the clinic timezone's wall clock
  // for the Metricool API automatically.
  publicationDate: string;
  firstCommentText?: string;
  media?: { url: string }[];
}

// Overridable so the end-to-end harness can point the client at a local mock.
// Production never sets it; app.metricool.com is the default.
export function apiBase(): string {
  return (process.env.METRICOOL_API_BASE || 'https://app.metricool.com/api').replace(/\/+$/, '');
}

function env() {
  const token = process.env.METRICOOL_USER_TOKEN;
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;
  if (!token || !blogId || !userId) {
    throw new Error('Metricool env vars missing (METRICOOL_USER_TOKEN/BLOG_ID/USER_ID)');
  }
  return { token, blogId, userId };
}

/** True when the three Metricool credentials are present. */
export function metricoolConfigured(): boolean {
  return Boolean(
    process.env.METRICOOL_USER_TOKEN &&
    process.env.METRICOOL_BLOG_ID &&
    process.env.METRICOOL_USER_ID
  );
}

// Every call is bounded. Without this a slow upstream held the whole serverless
// function until the platform killed it, which returns a bodyless 504 the UI
// cannot explain — see the schedule/insights routes.
const DEFAULT_TIMEOUT_MS = 15_000;

async function metricoolFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { token, blogId, userId } = env();
  const url = new URL(apiBase() + path);
  url.searchParams.set('blogId', blogId);
  url.searchParams.set('userId', userId);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), {
      ...init,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Mc-Auth': token, ...(init.headers || {}) },
    });
  } catch (e) {
    if ((e as any)?.name === 'AbortError') {
      throw new Error('Metricool timed out after ' + ((init.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000) + 's');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Metricool wants a wall-clock "YYYY-MM-DDTHH:MM:SS" plus an IANA timezone —
// it rejects/misreads full ISO strings with 'Z' or milliseconds. Convert the
// UTC instant we store internally into the clinic timezone's wall clock so the
// post shows up in the Metricool planner at the intended local time.
function wallClock(publicationDate: string): string {
  const at = new Date(publicationDate);
  return isNaN(at.getTime()) ? String(publicationDate) : formatForMetricool(at, SCHEDULE_TZ);
}

export async function metricoolSchedulePost(input: SchedulePostInput, mode: PostMode = 'review') {
  const body = {
    text: input.text,
    // Metricool's scheduler expects provider OBJECTS ({ network }), not bare
    // strings — this mirrors the interactive /api/metricool/schedule route.
    // Sending bare strings silently fails / mis-files the post.
    providers: input.providers.map((network) => ({ network })),
    publicationDate: { dateTime: wallClock(input.publicationDate), timezone: SCHEDULE_TZ },
    firstCommentText: input.firstCommentText,
    media: input.media || [],
    // Publishing is a human decision. The default lands the post in Metricool's
    // review queue; only an explicit `mode: 'scheduled'` — which every caller
    // reaches through a person pressing Approve in the dashboard — puts it in
    // the live queue. draft:true is what keeps an autoPublish:false post out of
    // the live-pending state.
    ...modeFlags(mode),
  };

  const res = await metricoolFetch('/v2/scheduler/posts', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Metricool ' + res.status + ': ' + JSON.stringify(data));
  }
  return data;
}

/** Pull the post id out of whatever envelope Metricool answered with. */
export function readPostId(data: any): string | null {
  const post = data && data.data ? data.data : data;
  const id = post && (post.id ?? post.postId);
  return id == null || id === '' ? null : String(id);
}

/**
 * Move an already-scheduled post to a new time.
 *
 * The dashboard used to update only its own `posts` row, so a reschedule in the
 * queue or a drag on the calendar moved the chip and left Metricool holding the
 * original time — the post then published on the old date while every screen in
 * the app showed the new one. Callers must treat a throw here as "the move did
 * not happen" and leave their local row alone.
 *
 * Metricool's PUT is a REPLACE, not a patch. Sending only the new
 * publicationDate is rejected:
 *
 *   400 ValidationError { text: "must not be null",
 *                         providers: "must not be empty" }
 *
 * so the post's existing text and networks have to be sent back with it. They
 * come from our own `posts` row, which is written at schedule time and is the
 * same content Metricool already holds. `draft` and `autoPublish` are repeated
 * here for the same reason they are constants everywhere else: a replace that
 * omitted them would drop the post out of the review queue.
 */
/**
 * REPLACE a post in Metricool. Everything the post should still have must be
 * in `post` — text, networks, date, media and which queue it sits in.
 */
export async function metricoolReplacePost(postId: string, post: ReplacePostInput): Promise<void> {
  const res = await metricoolFetch('/v2/scheduler/posts/' + encodeURIComponent(postId), {
    method: 'PUT',
    body: JSON.stringify(replacePostBody(post)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Metricool ' + res.status + ': ' + detail.slice(0, 300));
  }
}

/**
 * Move a post to a new time, keeping it in whichever queue it is already in.
 * A post the reviewer has approved must not fall back into review because it
 * was dragged to another day; a draft must not go live because it was moved.
 */
export async function metricoolUpdatePostDate(
  postId: string,
  publicationDate: string,
  post: { text: string; providers: Provider[]; media?: { url: string }[]; mode?: PostMode },
): Promise<void> {
  await metricoolReplacePost(postId, {
    text: post.text,
    providers: post.providers,
    publicationDate,
    media: post.media,
    mode: post.mode || 'review',
  });
}

/**
 * Remove a scheduled post from Metricool.
 *
 * A post Metricool no longer has (404/410) counts as deleted: the caller's goal
 * is "this post is gone", and refusing to clean up the local row because the
 * remote copy is already missing would strand it forever.
 */
export async function metricoolDeletePost(postId: string): Promise<void> {
  const res = await metricoolFetch('/v2/scheduler/posts/' + encodeURIComponent(postId), {
    method: 'DELETE',
  });
  if (res.ok || res.status === 404 || res.status === 410) return;
  const detail = await res.text().catch(() => '');
  throw new Error('Metricool ' + res.status + ': ' + detail.slice(0, 300));
}

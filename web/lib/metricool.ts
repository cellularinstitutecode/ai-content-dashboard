// Server-only Metricool client.
// Docs: https://app.metricool.com/resources/apidocs/index.html
// Base: https://app.metricool.com/api  |  Auth header: X-Mc-Auth: <userToken>

import { formatForMetricool, SCHEDULE_TZ } from '@/lib/timezone';
import { modeFlags, replacePostBody, type PostMode, type ReplacePostInput } from '@/lib/metricool-post';
import type { YoutubeData } from '@/lib/youtube-meta';
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
  /** YouTube's own fields — title, Short-or-video, visibility, audience. */
  youtubeData?: YoutubeData | null;
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

/**
 * Hand Metricool a media URL it will actually keep.
 *
 * THIS STEP WAS MISSING ENTIRELY, and it is why no post this app has ever sent
 * arrived with its picture or its video. Metricool does not attach a raw URL
 * from the `media` array: the URL has to be normalised first — the file is
 * pulled onto Metricool's own storage and a usable reference comes back — and
 * a post whose media was not normalised is, in their own words, "scheduled
 * without media". Silently. With a 200. So every image and every video we sent
 * was dropped on the floor, and the first anyone knew of it was Metricool's
 * own editor refusing to save the draft with "Add at least 1 video."
 *
 * The response shape is not pinned down in the public documentation, so this
 * accepts the handful it could reasonably be — a bare string, {url}, {data:{url}},
 * {mediaId}, {id} — and reports anything it cannot read rather than guessing.
 * A shape we do not recognise is logged WITH its body, so the first real run
 * says what the contract actually is instead of failing the same way twice.
 *
 * Returns the URL to put in the post. Never throws: losing the picture is bad,
 * losing the post is worse — the caller sends what it has and the draft still
 * lands for a person to look at.
 */
export async function normalizeMedia(rawUrl: string): Promise<string> {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  try {
    const res = await metricoolFetch('/actions/normalize/image/url?url=' + encodeURIComponent(url));
    if (!res.ok) {
      console.warn('metricool:normalize-media non-ok', res.status);
      return url;
    }
    const raw = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(raw); } catch { data = raw; }

    // A bare URL, quoted or not.
    if (typeof data === 'string') {
      const t = data.trim().replace(/^"|"$/g, '');
      return /^https?:\/\//i.test(t) ? t : url;
    }
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const inner = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;
    for (const key of ['url', 'normalizedUrl', 'mediaUrl', 'mediaId', 'id']) {
      const v = inner[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    console.warn('metricool:normalize-media unrecognised response', raw.slice(0, 300));
    return url;
  } catch (e) {
    console.warn('metricool:normalize-media failed', e instanceof Error ? e.message : String(e));
    return url;
  }
}

/** Normalise every attachment, in order, dropping the ones that come back empty. */
export async function normalizeMediaList(urls: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const u of urls) {
    const n = await normalizeMedia(u);
    if (n) out.push(n);
  }
  return out;
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
  // Normalised before the post is built, never after: an un-normalised URL is
  // accepted and then discarded, so "media sent" and "media attached" are two
  // different things and only this call makes them the same one.
  const media = await normalizeMediaList((input.media || []).map((m) => m.url).filter(Boolean));

  const body = {
    text: input.text,
    // Metricool's scheduler expects provider OBJECTS ({ network }), not bare
    // strings — this mirrors the interactive /api/metricool/schedule route.
    // Sending bare strings silently fails / mis-files the post.
    providers: input.providers.map((network) => ({ network })),
    publicationDate: { dateTime: wallClock(input.publicationDate), timezone: SCHEDULE_TZ },
    firstCommentText: input.firstCommentText,
    // An array of URLs. This was an array of {url} OBJECTS, which is the shape
    // Metricool ANSWERS with, not the one it accepts.
    media,
    // Only sent for a YouTube post, and only when there is a real title:
    // Metricool refuses to save a YouTube draft without one.
    ...(input.youtubeData && input.providers.includes('youtube') ? { youtubeData: input.youtubeData } : {}),
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
  post: { text: string; providers: Provider[]; media?: string[]; mode?: PostMode },
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

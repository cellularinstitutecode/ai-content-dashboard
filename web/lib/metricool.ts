// Server-only Metricool client.
// Docs: https://app.metricool.com/resources/apidocs/index.html
// Base: https://app.metricool.com/api  |  Auth header: X-Mc-Auth: <userToken>

import { formatForMetricool, SCHEDULE_TZ } from '@/lib/timezone';
import { modeFlags, replacePostBody, type PostMode, type ReplacePostInput } from '@/lib/metricool-post';
import type { YoutubeData } from '@/lib/youtube-meta';
import type { TiktokData } from '@/lib/tiktok-meta';
import { recordProviderOutcome } from '@/lib/provider-status';
import { readNormalizedUrl } from '@/lib/metricool-normalize-parse';
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
  /** TikTok's own settings (public, comments/duet/stitch on). lib/tiktok-meta.ts. */
  tiktokData?: TiktokData | null;
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
/** Does the URL name a video file? Decides which normalise endpoint is tried first. */
export function looksLikeVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(url || ''));
}

export type NormalizeOutcome = {
  /** What to put in the post: Metricool's own reference, or '' when it failed. */
  url: string;
  ok: boolean;
  /** Metricool's status, when it answered at all. */
  status: number | null;
  /** The transport failure, when it did not. */
  error: string | null;
  /**
   * The answer's structure, in TYPES — "{data:string, status:number}".
   *
   * Carried so an unreadable reply diagnoses itself on the screen instead of in
   * a console nobody reads. Types only: the shape is the fact worth having, and
   * a response body is not ours to display.
   */
  shape?: string;
  /** Every endpoint tried, and what it answered. Reported when none worked. */
  attempts?: { path: string; status: number; method?: string }[];
  /**
   * Metricool handed back the very URL it was given.
   *
   * Not a normalise: the file never moved onto their storage, and a post
   * carrying that URL is one they accept with a 200 and publish with no video.
   * Distinguished from every other failure because it is the one that LOOKS
   * like success — and, until this flag existed, was the one whose diagnosis
   * fell through the caller entirely.
   */
  echoed?: boolean;
};

/**
 * Normalise one URL, keeping the reason when it does not work.
 *
 * The status was ALREADY KNOWN here — logged to a console nobody reads — while
 * the person was told "the video copy needs a look" for a 403, a 413, a 502 and
 * a timeout alike. lib/media-normalize-reason.ts turns this into the sentence.
 */
/** The same link, allowing for a trailing slash or a different case of host. */
function sameUrl(a: string, b: string): boolean {
  const norm = (v: string) => String(v || '').trim().replace(/\/+$/, '');
  if (norm(a) === norm(b)) return true;
  try {
    const x = new URL(norm(a));
    const y = new URL(norm(b));
    return x.host.toLowerCase() === y.host.toLowerCase() && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

export async function normalizeMediaDetailed(rawUrl: string): Promise<NormalizeOutcome> {
  const url = String(rawUrl || '').trim();
  if (!url) return { url: '', ok: false, status: null, error: 'no url', attempts: [] };
  let lastStatus: number | null = null;
  /** Which endpoints answered what. Reported when nothing worked. */
  const attempts: { path: string; status: number; method?: string }[] = [];
  try {
    // 60s, not the client's usual 15. Normalising is not a metadata call: it is
    // Metricool PULLING the file onto its own storage, and the clinic's reels
    // run to hundreds of megabytes. At 15s a large video aborts, the catch
    // below hands back the un-normalised URL, and the media is dropped exactly
    // as it was before any of this was written — a silent regression that only
    // shows up on the big files that matter most.
    //
    // A video is offered to the video endpoint first; every video this app
    // ever sent went through `image/url`, the only path the code knew. If
    // Metricool has no such endpoint it answers non-ok and the image one is
    // tried, exactly as before — and the log says which one answered.
    // THE PATH, in the order most likely to be the right one.
    //
    // Every other call in this file is versioned — /v2/scheduler/posts — and
    // this one alone was not. That may be correct (it has worked for smaller
    // files) or may be why a large one comes back with an answer holding no
    // reference; from here there is no way to tell, because this sandbox cannot
    // reach app.metricool.com to ask. So both spellings are tried, cheaply: a
    // wrong path 404s in milliseconds, and whichever answers is recorded in
    // `attempts` and reported on the screen when the whole thing fails.
    const isVideo = looksLikeVideoUrl(url);
    const paths = isVideo
      ? ['/v2/actions/normalize/video/url', '/actions/normalize/video/url', '/v2/actions/normalize/image/url', '/actions/normalize/image/url']
      : ['/v2/actions/normalize/image/url', '/actions/normalize/image/url'];
    // Four minutes for a video, one for an image.
    //
    // Sixty seconds was the figure from when the video came off a CDN. It now
    // comes from wherever this app serves it, and Metricool is not fetching a
    // thumbnail: it is pulling a 96 MB to 1.8 GB file onto its own storage
    // before it answers. A minute is not long enough for the smallest reel in
    // the sheet, and the timeout's consequence is not a slow post — the catch
    // below hands back the UN-normalised URL, normalizeMediaList flags
    // `degraded`, and the post is refused. Every attach would fail.
    const timeoutMs = isVideo ? 240_000 : 60_000;
    let res: Response | null = null;
    // GET first, because that is what has been sent all along and what has
    // worked for the files that did go through. POST second, on the same
    // paths, because an upload action is as likely to be a POST as a GET and
    // this app has never tried one — a wrong method is answered in
    // milliseconds, so asking costs nothing and settles it.
    outer: for (const method of ['GET', 'POST'] as const) {
      for (const path of paths) {
        res = await metricoolFetch(path + '?url=' + encodeURIComponent(url), { timeoutMs, method });
        attempts.push({ path, status: res.status, method });
        if (res.ok) { console.info('metricool:normalize-media via', method, path); break outer; }
        lastStatus = res.status;
        console.warn('metricool:normalize-media non-ok', method, path, res.status);
      }
    }
    if (!res || !res.ok) return { url, ok: false, status: lastStatus, error: null, attempts };
    const raw = await res.text();
    // Read the way a person would: find the reference in the answer, whatever
    // it is called and however deep it sits. The reader this replaced knew five
    // shapes and looked one level into `data` only when `data` was an object —
    // so `{"data": "https://…"}`, the most ordinary REST shape there is, fell
    // through it and a 477 MB upload that had already crossed the wire was
    // discarded over a key name. lib/metricool-normalize-parse.ts.
    const parsed = readNormalizedUrl(raw, url);
    if (parsed.url) {
      // THE ECHO. Their answer held no reference but ours — the file did not
      // move — and calling that a success cost this app a whole round of
      // diagnosis: `ok: true` meant the caller recorded no failure, so the
      // message that reached the screen had neither the reply's shape nor the
      // endpoints tried in it, which were the two facts worth having.
      const echoed = sameUrl(parsed.url, url);
      return {
        url: parsed.url,
        ok: !echoed,
        status: res.status,
        error: null,
        shape: parsed.shape,
        attempts,
        ...(echoed ? { echoed: true } : {}),
      };
    }
    console.warn('metricool:normalize-media unrecognised response', parsed.shape, raw.slice(0, 300));
    return { url, ok: false, status: res.status, error: null, shape: parsed.shape, attempts };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('metricool:normalize-media failed', message);
    return { url, ok: false, status: lastStatus, error: message, attempts };
  }
}

/** The URL to post, or the one we were given when it did not work. Unchanged for callers that only need that. */
export async function normalizeMedia(rawUrl: string): Promise<string> {
  const out = await normalizeMediaDetailed(rawUrl);
  return out.url;
}

/**
 * Normalise every attachment, in order, dropping the ones that come back empty.
 *
 * `degraded` is the part that matters: a normalise that failed returns the
 * ORIGINAL url, which Metricool accepts with a 200 and then silently discards.
 * Without a flag saying so, the caller reports a perfectly successful post and
 * the person finds out days later from Metricool's own editor. Callers that can
 * surface a warning should; none may treat this as ordinary success.
 */
export async function normalizeMediaList(
  urls: readonly string[],
): Promise<{ media: string[]; degraded: boolean; failure: NormalizeOutcome | null }> {
  const media: string[] = [];
  let degraded = false;
  /** The FIRST thing that went wrong, kept so the caller can say what it was. */
  let failure: NormalizeOutcome | null = null;
  for (const u of urls) {
    // Compared against the TRIMMED input, because normalizeMedia trims before it
    // does anything. Comparing against the raw string made a URL with a trailing
    // newline look normalised when it had not been: n !== u, degraded false, and
    // the post queued with a raw URL that Metricool drops in silence — which is
    // the one case this flag exists to catch.
    const trimmed = String(u || '').trim();
    const out = await normalizeMediaDetailed(trimmed);
    const n = out.url;
    if (!out.ok && !failure) failure = out;
    if (!n) {
      // An input we cannot normalise to anything is not "no media requested" —
      // it is media that will not arrive. Skipping it quietly produced a post
      // with an empty media list, reported as a success.
      if (trimmed) degraded = true;
      continue;
    }
    // Unchanged means normalise did not happen — every success path returns
    // Metricool's own reference, never the URL it was given.
    if (n === trimmed) {
      degraded = true;
      // And it is a FAILURE, with everything known about it. This was the hole:
      // an echoed URL set `degraded` without setting `failure`, so the caller
      // had nothing to explain it with and printed the bare fallback sentence —
      // no status, no shape, no endpoints. Two rounds of "it still says the
      // same thing" came out of that.
      if (!failure) failure = { ...out, ok: false, echoed: true };
    }
    media.push(n);
  }
  return { media, degraded, failure };
}

// Metricool wants a wall-clock "YYYY-MM-DDTHH:MM:SS" plus an IANA timezone —
// it rejects/misreads full ISO strings with 'Z' or milliseconds. Convert the
// UTC instant we store internally into the clinic timezone's wall clock so the
// post shows up in the Metricool planner at the intended local time.
function wallClock(publicationDate: string): string {
  const at = new Date(publicationDate);
  return isNaN(at.getTime()) ? String(publicationDate) : formatForMetricool(at, SCHEDULE_TZ);
}

/**
 * Thrown before a post is created when its media did not normalise.
 *
 * This used to be a console.error and the post went out anyway — with a 200
 * from Metricool and no video in it. A post the person will approve believing
 * it carries its video is worse than no post: callers catch this by class and
 * say so.
 */
export class MediaNotNormalisedError extends Error {
  readonly code = 'media_unverified' as const;
  constructor(message = 'Metricool did not take the media, so the post was not created \u2014 a post without its video would have looked finished and gone out empty.') {
    super(message);
    this.name = 'MediaNotNormalisedError';
  }
}

export async function metricoolSchedulePost(input: SchedulePostInput, mode: PostMode = 'review') {
  // Normalised before the post is built, never after: an un-normalised URL is
  // accepted and then discarded, so "media sent" and "media attached" are two
  // different things and only this call makes them the same one.
  const { media, degraded } = await normalizeMediaList((input.media || []).map((m) => m.url).filter(Boolean));
  if (degraded) {
    // Refused, not warned about: the failure is otherwise invisible — Metricool
    // answers 200 and the post arrives with no video.
    console.error('metricool:media-not-normalised — the post is NOT created', { count: media.length });
    throw new MediaNotNormalisedError();
  }

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
    // TikTok's own settings, so the draft is a direct publication (public,
    // comments/duet/stitch on) and not Metricool's "finish on your phone" mode.
    ...(input.tiktokData && input.providers.includes('tiktok') ? { tiktokData: input.tiktokData } : {}),
    // Publishing is a human decision. The default lands the post in Metricool's
    // review queue; only an explicit `mode: 'scheduled'` — which every caller
    // reaches through a person pressing Approve in the dashboard — puts it in
    // the live queue. draft:true is what keeps an autoPublish:false post out of
    // the live-pending state.
    ...modeFlags(mode),
  };

  let res = await metricoolFetch('/v2/scheduler/posts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  let data = await res.json().catch(() => ({}));
  // The tiktokData field names come from public clients of this endpoint,
  // not from documentation this app could read. If Metricool refuses the
  // block by name, the post is sent once more without it — a wrong preset
  // costs the preset, never the post — and the log says so.
  if (!res.ok && res.status === 400 && 'tiktokData' in body && /tiktok/i.test(JSON.stringify(data))) {
    console.warn('metricool:tiktokData refused, sending without it', JSON.stringify(data).slice(0, 300));
    const withoutTiktok = { ...(body as Record<string, unknown>) };
    delete withoutTiktok.tiktokData;
    res = await metricoolFetch('/v2/scheduler/posts', { method: 'POST', body: JSON.stringify(withoutTiktok) });
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    const message = 'Metricool ' + res.status + ': ' + JSON.stringify(data);
    // Capability, not configuration. The `metricool` health check asks only
    // whether three environment variables are non-empty, so a rotated or
    // rejected token reported healthy indefinitely while every schedule failed
    // — the same blind spot the images check was rewritten to close.
    recordProviderOutcome('metricool', { ok: false, message });
    throw new Error(message);
  }
  recordProviderOutcome('metricool', { ok: true });
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

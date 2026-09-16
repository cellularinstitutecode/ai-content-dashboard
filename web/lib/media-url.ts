// web/lib/media-url.ts
// The signed URL that lets Metricool fetch a reel from us.
//
// WHY THIS EXISTS. Metricool pulls a post's video onto its own storage from a
// URL we give it, and every place we could put that video has now refused it:
//
//   - a Drive download link (drive.google.com/uc?export=download) answers a
//     >100 MB file with Google's virus-scan HTML page, which Metricool stored
//     as the video, with a 200, so the draft looked finished;
//   - Supabase Storage refuses any upload over 50 MB on the Free plan, and
//     that limit is fixed — it cannot be raised without upgrading. The reels
//     run 96 MB to 1.8 GB.
//
// So the app serves the file itself. This module mints
//
//     https://<base>/api/media/video/<driveId>/<exp>/<sig>/video.mp4
//
// and app/api/media/video/[...parts] answers it by streaming the bytes out of
// Drive with the service account that already reads them. Nothing is copied,
// nothing is stored, and there is no size limit to run into.
//
// The trailing /video.mp4 is load-bearing three times over: middleware.ts's
// matcher excludes any path ending in an extension, lib/metricool.ts's
// looksLikeVideoUrl needs it to choose the VIDEO normalise endpoint, and it is
// the extension the Drive link never had.
//
// Pure: crypto only, so the test runner reads this file directly.
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Key material for media URLs.
 *
 * Same chain as lib/assistant-token.ts's sessionKey(), with a dedicated name
 * first. A dedicated MEDIA_URL_SECRET is worth setting for one reason beyond
 * hygiene: rotating it invalidates every outstanding media URL in one action,
 * which is the only revocation this scheme has.
 */
export function mediaUrlSecret(): string {
  return process.env.MEDIA_URL_SECRET
    || process.env.ASSISTANT_SESSION_SECRET
    || process.env.CRON_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || '';
}

const VERSION = 'v1';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Thirty days.
 *
 * The URL has to outlive three separate fetches, not one: Metricool's
 * normalise, any retry it makes, and the re-normalise that happens when a post
 * is replaced on approve. Between the first and the last of those sits a human
 * approval, which in this clinic can be days.
 *
 * It is not unbounded because this is an unauthenticated handle on the
 * clinic's own footage. Expiry is never visible to anybody, because
 * ensureShareableVideo re-mints a stored URL before handing it on.
 */
export const MEDIA_URL_TTL_MS = 30 * DAY_MS;

/** Re-mint a stored URL once it has less than a week of life left. */
export const REMINT_FLOOR_MS = 7 * DAY_MS;

/**
 * The expiry stamped on a URL minted now, QUANTISED to the UTC day.
 *
 * Quantised so two mints on the same day produce the same URL, byte for byte.
 * Without that, every call on an already-known video would produce a different
 * string, the cache would be rewritten, and Metricool would re-fetch the whole
 * reel — for a press of a button that is supposed to cost one database read.
 * Always between 30 and 31 days of life.
 */
export function mediaUrlExpiry(now: number = Date.now()): number {
  return Math.ceil((now + MEDIA_URL_TTL_MS) / DAY_MS) * DAY_MS;
}

/** The bytes that are signed. Version-tagged so the scheme can change unambiguously. */
function canonical(fileId: string, exp: number): string {
  return VERSION + '\n' + fileId + '\n' + exp;
}

/** The signature for this file and expiry, or null when there is no key. */
export function signMediaPath(fileId: string, expMs: number): string | null {
  const key = mediaUrlSecret();
  const id = String(fileId || '').trim();
  if (!key || !id || !Number.isFinite(expMs)) return null;
  return createHmac('sha256', key).update(canonical(id, expMs)).digest('hex');
}

export type MediaVerdict =
  | { ok: true }
  | { ok: false; reason: 'no_key' | 'malformed' | 'expired' | 'bad_signature' };

/**
 * Is this a URL we minted, for this file, still inside its life?
 *
 * Fails CLOSED when there is no key: with nothing to sign with there is no way
 * to tell a minted URL from a crafted one, and the safe reading of "I cannot
 * tell" is no.
 *
 * Expiry is judged before the signature so an operator reading the log can
 * tell "re-mint" from "the key rotated or somebody is probing". The caller is
 * answered identically either way.
 */
export function verifyMediaSignature(fileId: string, exp: number, sig: string, now: number = Date.now()): MediaVerdict {
  const id = String(fileId || '').trim();
  const got = String(sig || '');
  if (!id || !got || !Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (!mediaUrlSecret()) return { ok: false, reason: 'no_key' };
  if (now > exp) return { ok: false, reason: 'expired' };
  const expect = signMediaPath(id, exp);
  if (!expect || expect.length !== got.length) return { ok: false, reason: 'bad_signature' };
  try {
    return timingSafeEqual(Buffer.from(expect), Buffer.from(got)) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

export const MEDIA_VIDEO_PREFIX = '/api/media/video/';
export const MEDIA_VIDEO_FILENAME = 'video.mp4';

/** No signing key. Thrown rather than returning a URL that cannot be verified. */
export class MediaKeyMissing extends Error {
  readonly code = 'no_media_key' as const;
  constructor() {
    super(
      'No media signing key is configured, so the video cannot be served to Metricool. '
      + 'Set MEDIA_URL_SECRET (openssl rand -hex 32) — CRON_SECRET is used as a fallback.',
    );
    this.name = 'MediaKeyMissing';
  }
}

/** The absolute URL Metricool is handed. Throws rather than mint an unsigned one. */
export function mediaVideoUrl(fileId: string, base: string, now: number = Date.now()): string {
  const id = String(fileId || '').trim();
  if (!id) throw new Error('mediaVideoUrl: no file id');
  const exp = mediaUrlExpiry(now);
  const sig = signMediaPath(id, exp);
  if (!sig) throw new MediaKeyMissing();
  return String(base || '').replace(/\/+$/, '') + MEDIA_VIDEO_PREFIX + id + '/' + exp + '/' + sig + '/' + MEDIA_VIDEO_FILENAME;
}

/** The four segments of a media path, or null. Never a guess. */
export function parseMediaPathParts(parts: readonly string[] | null | undefined): { fileId: string; exp: number; sig: string } | null {
  const p = (parts || []).map((s) => String(s ?? ''));
  if (p.length !== 4) return null;
  if (p[3] !== MEDIA_VIDEO_FILENAME) return null;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(p[0])) return null;
  if (!/^\d{10,16}$/.test(p[1])) return null;
  if (!/^[0-9a-f]{64}$/.test(p[2])) return null;
  return { fileId: p[0], exp: Number(p[1]), sig: p[2] };
}

/** The same fields recovered from a whole URL, for the re-mint decision. */
export function parseMediaVideoUrl(url: string | null | undefined): { base: string; fileId: string; exp: number; sig: string } | null {
  let u: URL;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (!u.pathname.startsWith(MEDIA_VIDEO_PREFIX)) return null;
  const parsed = parseMediaPathParts(u.pathname.slice(MEDIA_VIDEO_PREFIX.length).split('/'));
  return parsed ? { base: u.origin, ...parsed } : null;
}

/**
 * Is a stored URL still worth handing out?
 *
 * No when it names a different video, points at a host we no longer serve
 * from, was signed with a key that has since rotated, or has under a week
 * left. Anything unparseable is stale by definition.
 */
export function mediaUrlIsFresh(url: string | null | undefined, fileId: string, base: string, now: number = Date.now()): boolean {
  const p = parseMediaVideoUrl(url);
  if (!p) return false;
  if (p.fileId !== String(fileId || '').trim()) return false;
  if (p.base !== String(base || '').replace(/\/+$/, '')) return false;
  if (p.exp - now < REMINT_FLOOR_MS) return false;
  return verifyMediaSignature(p.fileId, p.exp, p.sig, now).ok;
}

// --- the copy-id marker ----------------------------------------------------
//
// public_copy_id and posts.media_drive_file_id have held two kinds of thing: a
// Drive copy's file id (a bare [A-Za-z0-9_-]{20,80}) and a bucket object key
// ('videos/<id>.mp4', lib/video-bucket.ts). This is the third.
//
// The colon is the point. The id wrapped here is the SOURCE video's own Drive
// id — the clinic's original footage — because the stream path makes no copy
// at all. Anything that reaches deleteDriveFile with it destroys the master.
// No Drive id contains a colon and no bucket key does either, so every delete
// dispatcher has one cheap, total test to apply before it does anything.

const STREAM_PREFIX = 'stream:';

export function streamCopyId(fileId: string): string {
  return STREAM_PREFIX + String(fileId || '').trim();
}

export function isStreamCopyId(id: string | null | undefined): boolean {
  return /^stream:[A-Za-z0-9_-]{20,80}$/.test(String(id || ''));
}

/** The source video id inside a stream marker, or null if it is not one. */
export function parseStreamCopyId(id: string | null | undefined): string | null {
  const s = String(id || '');
  return isStreamCopyId(s) ? s.slice(STREAM_PREFIX.length) : null;
}

/**
 * The marker for a URL this app serves, or null.
 *
 * Identification, not authorisation: the signature is deliberately NOT checked,
 * because an expired-but-well-formed URL still says which video it is, and the
 * callers of this are recording what a post carries, not deciding who may read
 * it.
 */
export function streamCopyIdFromUrl(url: string | null | undefined): string | null {
  const p = parseMediaVideoUrl(url);
  return p ? streamCopyId(p.fileId) : null;
}

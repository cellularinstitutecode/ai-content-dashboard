// web/lib/video-bucket-key.ts
// Naming and sizing rules for the video bucket, with nothing attached.
//
// Split out of lib/video-bucket.ts, which is server-only and pulls in the
// Supabase admin client: these four answers are decisions, not I/O, and the
// one that matters most — telling a bucket key apart from a Drive file id —
// guards a delete path that can destroy the clinic's original footage. That
// deserves a test, and a test cannot load a server-only module.
//
// lib/video-bucket.ts re-exports all of this, so every existing import of it
// keeps working unchanged.

export const VIDEO_BUCKET = process.env.VIDEO_BUCKET || 'content-videos';

/**
 * The largest file Supabase Storage will accept.
 *
 * The project is on the FREE plan, whose GLOBAL upload file size limit is
 * FIXED at 50 MB — Storage → Settings shows the field greyed out, and raising
 * it means upgrading to Pro. The clinic's reels run 96 MB to 1.8 GB, so the
 * bucket stopped being the answer for anything it actually posts. Those go out
 * through the app's own streaming route instead (lib/media-url.ts).
 *
 * Checked against Drive's own reported size BEFORE the download, so a 144 MB
 * reel costs one metadata call rather than a 144 MB transfer that Supabase
 * then refuses. Set SUPABASE_UPLOAD_MAX_BYTES if the plan ever changes;
 * nothing else has to move.
 */
export function bucketUploadMaxBytes(): number {
  const n = Number(process.env.SUPABASE_UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
}

/** The object key for a source video: one per video, so re-staging replaces rather than multiplies. */
export function bucketKeyFor(fileId: string): string {
  return 'videos/' + String(fileId || '').trim() + '.mp4';
}

/** Is this recorded copy id one of ours in the bucket (as opposed to a Drive copy id)? */
export function isBucketVideoKey(id: string | null | undefined): boolean {
  return /^videos\/[A-Za-z0-9_-]{20,80}\.mp4$/.test(String(id || ''));
}

/** The object key inside a Supabase public URL for this bucket, or null. */
export function bucketKeyFromUrl(url: string | null | undefined, bucket: string = VIDEO_BUCKET): string | null {
  const m = /\/storage\/v1\/object\/public\/([^/]+)\/(.+?)(?:[?#]|$)/.exec(String(url || ''));
  if (!m) return null;
  if (m[1] !== bucket) return null;
  try { return decodeURIComponent(m[2]); } catch { return m[2]; }
}

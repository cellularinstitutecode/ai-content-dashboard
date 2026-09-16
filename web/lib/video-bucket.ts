// web/lib/video-bucket.ts
// The videos a post carries, in a bucket this app controls.
//
// THE PROBLEM. Metricool was handed a Drive download link
// (drive.google.com/uc?export=download&id=…) to the world-readable copy the
// app made of each reel. For a file over about a hundred megabytes Google
// answers that link with its "cannot scan this file for viruses" HTML page,
// not the MP4 — so Metricool stored a web page as the post's media, with a
// 200, and the draft looked finished until somebody opened it.
//
// THE FIX. The file is streamed from Drive into Supabase Storage — the bucket
// the app's images already live in the same way — as one `videos/<id>.mp4`
// per SOURCE video, and Metricool gets that direct, extensionful, public URL.
// lib/media-verify.ts then reads the first bytes back anonymously before the
// URL is ever recorded or sent.
//
// Files larger than the scratch disk can hold keep the Drive-copy path (the
// caller decides), verified the same way.
import 'server-only';

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { driveMediaStream, probeDriveMedia } from '@/lib/google-sources';
import { DISK_SAFE_BYTES } from '@/lib/media-route';
import { reportError } from '@/lib/report';

const BUCKET = process.env.VIDEO_BUCKET || 'content-videos';
/** The public bucket every post's video is streamed into. */
export const VIDEO_BUCKET = BUCKET;
/** Per-bucket ceiling set when the bucket is created. Supabase's global limit must allow it too. */
const BUCKET_FILE_LIMIT = '1GB';

/** The object key for a source video: one per video, so re-staging replaces rather than multiplies. */
export function bucketKeyFor(fileId: string): string {
  return 'videos/' + String(fileId || '').trim() + '.mp4';
}

/** Is this recorded copy id one of ours in the bucket (as opposed to a Drive copy id)? */
export function isBucketVideoKey(id: string | null | undefined): boolean {
  return /^videos\/[A-Za-z0-9_-]{20,80}\.mp4$/.test(String(id || ''));
}

/** The object key inside a Supabase public URL for this bucket, or null. */
export function bucketKeyFromUrl(url: string | null | undefined): string | null {
  const m = /\/storage\/v1\/object\/public\/([^/]+)\/(.+?)(?:[?#]|$)/.exec(String(url || ''));
  if (!m) return null;
  if (m[1] !== BUCKET) return null;
  try { return decodeURIComponent(m[2]); } catch { return m[2]; }
}

export type StagedVideo =
  | { ok: true; key: string; url: string; bytes: number; sizeBytes: number | null; contentType: string }
  | { ok: false; reason: 'not_media' | 'too_large' | 'unreachable' | 'upload_limit' | 'failed'; message: string; sizeBytes?: number | null };

/**
 * Stream a Drive video into the bucket and answer with its public URL.
 *
 * Staged on the scratch disk first, so the byte count is known before the
 * upload and the upload can name its length. `too_large` means larger than
 * the scratch disk can hold — the caller keeps the Drive copy for those.
 * Never throws.
 */
export async function stageVideoInBucket(fileId: string, opts: { transferMs?: number } = {}): Promise<StagedVideo> {
  const id = String(fileId || '').trim();
  if (!id) return { ok: false, reason: 'failed', message: 'No video id.' };

  const probe = await probeDriveMedia(id, Number.POSITIVE_INFINITY);
  if (!probe.ok) {
    const reason = probe.reason === 'not_media' ? 'not_media' : 'unreachable';
    return { ok: false, reason, message: probe.message };
  }
  const sizeBytes = typeof probe.sizeBytes === 'number' && Number.isFinite(probe.sizeBytes) ? probe.sizeBytes : null;
  if (sizeBytes != null && sizeBytes > DISK_SAFE_BYTES) {
    return { ok: false, reason: 'too_large', sizeBytes, message: Math.round(sizeBytes / 1024 / 1024) + ' MB is more than this function can stage; the Drive copy is used instead.' };
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'chi-video-'));
    const tmp = join(dir, id + '.mp4');
    const res = await driveMediaStream(id, opts.transferMs ?? 240_000);
    if (!res.ok || !res.body) {
      return { ok: false, reason: 'unreachable', message: 'Drive answered HTTP ' + res.status + ' to the download.' };
    }
    await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), createWriteStream(tmp));
    const bytes = (await stat(tmp)).size;
    if (sizeBytes != null && bytes !== sizeBytes) {
      return { ok: false, reason: 'failed', sizeBytes, message: 'The download stopped at ' + bytes.toLocaleString() + ' of ' + sizeBytes.toLocaleString() + ' bytes.' };
    }

    const key = bucketKeyFor(id);
    const contentType = 'video/mp4';
    const db = supabaseAdmin();
    const doUpload = () => db.storage.from(BUCKET).upload(key, createReadStream(tmp), {
      contentType,
      upsert: true,
      duplex: 'half',
      headers: { 'content-length': String(bytes) },
    } as Parameters<ReturnType<typeof db.storage.from>['upload']>[2]);

    let { error } = await doUpload();
    if (error && /bucket/i.test(error.message || '')) {
      // First run: create the public bucket with a ceiling that fits a reel, then retry once.
      try { await db.storage.createBucket(BUCKET, { public: true, fileSizeLimit: BUCKET_FILE_LIMIT, allowedMimeTypes: ['video/mp4', 'video/quicktime'] }); }
      catch (e) { reportError('video-bucket:create', e); }
      ({ error } = await doUpload());
    }
    if (error) {
      const msg = String(error.message || '');
      if (/exceed|too large|maximum|413|size/i.test(msg)) {
        return {
          ok: false, reason: 'upload_limit', sizeBytes,
          message: 'Supabase refused the upload as too large (' + Math.round(bytes / 1024 / 1024) + ' MB). Raise the Supabase storage upload limit (Storage → Settings → global file size limit) above the default 50 MB.',
        };
      }
      return { ok: false, reason: 'failed', sizeBytes, message: 'The video could not be stored: ' + msg };
    }
    const { data } = db.storage.from(BUCKET).getPublicUrl(key);
    if (!data?.publicUrl) return { ok: false, reason: 'failed', sizeBytes, message: 'The stored video has no public URL.' };
    return { ok: true, key, url: data.publicUrl, bytes, sizeBytes, contentType };
  } catch (e) {
    reportError('video-bucket:stage', e, { fileId: id });
    const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, reason: aborted ? 'unreachable' : 'failed', sizeBytes, message: aborted ? 'Downloading the video from Drive ran out of time.' : (e instanceof Error ? e.message : String(e)) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove a staged video. Best-effort, never throws. */
export async function deleteBucketVideo(key: string): Promise<void> {
  const k = String(key || '').trim();
  if (!k) return;
  try {
    const { error } = await supabaseAdmin().storage.from(BUCKET).remove([k]);
    if (error) reportError('video-bucket:remove', error, { key: k });
  } catch (e) {
    reportError('video-bucket:remove', e, { key: k });
  }
}

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
// THE FIX AFTER THAT. The project is on Supabase's FREE plan, whose global
// upload file size limit is FIXED at 50 MB — the field is greyed out, and
// raising it means upgrading. The clinic's reels run 96 MB to 1.8 GB, so this
// path now serves only the small ones. Anything bigger is refused here, before
// a byte is transferred, and lib/media-library.ts hands it to the app's own
// streaming route instead (lib/media-url.ts). Nothing about this module was
// removed: a file Supabase will take still belongs in the bucket, where
// serving it costs us nothing.
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

// The naming and sizing rules live in a module with nothing attached, so they
// can be tested; everything that imported them from here still can.
import { VIDEO_BUCKET, bucketKeyFor, bucketUploadMaxBytes } from '@/lib/video-bucket-key';
export { VIDEO_BUCKET, bucketKeyFor, bucketKeyFromUrl, bucketUploadMaxBytes, isBucketVideoKey } from '@/lib/video-bucket-key';

const BUCKET = VIDEO_BUCKET;
/**
 * The ceiling asked for when the bucket is created.
 *
 * Supabase refuses a bucket limit above the project's GLOBAL file size limit
 * (Storage → Settings), which is 50 MB on the Free plan and cannot be raised
 * there. When that refusal happens the bucket is created without a ceiling
 * instead, so it exists either way.
 */
const BUCKET_FILE_LIMIT = '1GB';
const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'];

/** What an upload refused for its size means now that the limit cannot be raised. */
function uploadLimitMessage(bytes: number, detail: string): string {
  return 'Supabase refused the video as too large (' + Math.round(bytes / 1024 / 1024) + ' MB); '
    + 'the Free plan\u2019s upload limit is fixed at ' + Math.round(bucketUploadMaxBytes() / 1024 / 1024) + ' MB. '
    + 'The video is served from the dashboard instead.'
    + (detail ? ' (' + detail.slice(0, 120) + ')' : '');
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
  // Refused BEFORE the transfer, on Drive's own reported size. The old order
  // pulled the whole file onto the scratch disk and only then discovered that
  // Supabase would not take it — a 144 MB download, every time, for nothing.
  const ceiling = Math.min(DISK_SAFE_BYTES, bucketUploadMaxBytes());
  if (sizeBytes != null && sizeBytes > ceiling) {
    const why = bucketUploadMaxBytes() < DISK_SAFE_BYTES
      ? 'more than Supabase will accept on this plan (' + Math.round(bucketUploadMaxBytes() / 1024 / 1024) + ' MB)'
      : 'more than this function can stage';
    return {
      ok: false,
      reason: sizeBytes > DISK_SAFE_BYTES ? 'too_large' : 'upload_limit',
      sizeBytes,
      message: Math.round(sizeBytes / 1024 / 1024) + ' MB is ' + why + '; the video is served from the dashboard instead.',
    };
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
      // First run: create the public bucket, then retry the upload once.
      //
      // Read the RETURNED error, not a thrown one: createBucket resolves with
      // { error } like every other supabase-js call, so a try/catch here saw
      // nothing and the failure was discarded. And a bucket ceiling above the
      // project's GLOBAL file size limit is refused outright — so asking for
      // 1 GB while the project is still on the 50 MB default failed to create
      // the bucket at all, and the next line reported "Bucket not found"
      // instead of the one sentence that fixes it. Second attempt inherits the
      // global limit, so the bucket exists either way and an oversized file
      // fails below with an answer a person can act on.
      const made = await db.storage.createBucket(BUCKET, { public: true, fileSizeLimit: BUCKET_FILE_LIMIT, allowedMimeTypes: VIDEO_MIME_TYPES });
      if (made.error) {
        reportError('video-bucket:create', made.error, { limit: BUCKET_FILE_LIMIT });
        const retry = await db.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: VIDEO_MIME_TYPES });
        if (retry.error) reportError('video-bucket:create-plain', retry.error);
      }
      ({ error } = await doUpload());
    }
    if (error) {
      const msg = String(error.message || '');
      if (/exceed|too large|maximum|payload|413|size limit/i.test(msg)) {
        return { ok: false, reason: 'upload_limit', sizeBytes, message: uploadLimitMessage(bytes, msg) };
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

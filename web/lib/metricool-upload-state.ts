// web/lib/metricool-upload-state.ts
// Where a Metricool upload that one request could not finish is kept.
//
// See supabase/metricool-uploads.sql. A multipart upload is a list of slices,
// each its own PUT with its own ETag, so it resumes at the first slice that
// has none — and the hashing that precedes it resumes at the first slice not
// yet measured. Everything below is best-effort: with the table missing (the
// SQL not yet run) or the database unreachable, every function answers as if
// nothing were stored, the upload runs the way it did before this existed,
// and the health check names the missing table. Never throws.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { isMissingSchema } from '@/lib/schema-probe';
import { reportError } from '@/lib/report';
import type { DeclaredPart, OpenedTransaction } from '@/lib/metricool-upload-parse';

export type UploadState = {
  videoId: string;
  blogId: string | null;
  sizeBytes: number;
  contentType: string;
  /** The slices measured so far — all of them once `status` is 'uploading'. */
  declared: DeclaredPart[];
  /** Metricool's reply to the open; null while still hashing. */
  tx: OpenedTransaction | null;
  /** partNumber -> ETag. */
  etags: Record<string, string>;
  /** Epoch ms after which the signed addresses are dead, or null when unknown. */
  expiresAt: number | null;
  status: 'hashing' | 'uploading' | 'done' | 'failed';
  updatedAt: number;
};

const TABLE = 'metricool_uploads';

/** How long one request may hold a video before another may take over. Longer than any function lives. */
export const UPLOAD_CLAIM_MS = 6 * 60_000;

function quiet(where: string, error: { code?: string; message?: string } | null | undefined, ctx: Record<string, string>): void {
  if (!error) return;
  // A missing table is a migration not yet run, which the health check says
  // out loud; it is not worth an error per upload on top.
  if (isMissingSchema(error.code)) return;
  reportError(where, error, ctx);
}

/**
 * Claim this video for one request.
 *
 * The composer sends a post to its networks in parallel and each send asks
 * for the copy, so without this three requests hashed and uploaded the same
 * file at once, each overwriting the others' record. The claim is a row
 * (created here if the video has none) whose `claimed_until` is in the past
 * or empty; taking it sets it into the future. A request that cannot take it
 * answers "in progress" and lets the claimant carry on.
 *
 * `true` when the table is missing: the upload then runs unrecorded, as it
 * did before the table existed, rather than refusing every send.
 */
export async function claimUpload(videoId: string, sizeBytes: number, blogId: string | null): Promise<boolean> {
  const id = String(videoId || '').trim();
  if (!id) return false;
  const now = new Date();
  const until = new Date(now.getTime() + UPLOAD_CLAIM_MS).toISOString();
  const db = supabaseAdmin();
  // Take an existing, unclaimed row.
  const taken = await db
    .from(TABLE)
    .update({ claimed_until: until, updated_at: now.toISOString() })
    .eq('video_id', id)
    .or('claimed_until.is.null,claimed_until.lt.' + now.toISOString())
    .select('video_id')
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { code?: string; message?: string } }));
  if (taken.error) {
    if (isMissingSchema(taken.error.code)) return true;
    reportError('metricool-upload-state:claim', taken.error, { videoId: id });
    return false;
  }
  if (Array.isArray(taken.data) && taken.data.length) return true;
  // No row yet, or one somebody else holds. Try to create it; a duplicate-key
  // refusal means another request created it first, and that request holds it.
  const exists = await db.from(TABLE).select('video_id').eq('video_id', id).maybeSingle()
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { code?: string; message?: string } }));
  if (exists.data) return false;
  const made = await db
    .from(TABLE)
    .insert({
      video_id: id, blog_id: blogId, size_bytes: sizeBytes, content_type: 'video/mp4',
      declared: [], transaction: null, etags: {}, status: 'hashing', hashed_bytes: 0,
      claimed_until: until, updated_at: now.toISOString(),
    })
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  if (made.error) {
    if (isMissingSchema(made.error.code)) return true;
    if (made.error.code !== '23505') reportError('metricool-upload-state:claim-insert', made.error, { videoId: id });
    return false;
  }
  return true;
}

/** Let the next request take the video. Called on every way out of an upload. */
export async function releaseUpload(videoId: string): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .update({ claimed_until: null, updated_at: new Date().toISOString() })
    .eq('video_id', videoId)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:release', r.error, { videoId });
}

/** The upload in progress for this video, hashing or uploading, or null. A finished or failed one is not resumed. */
export async function loadUploadState(videoId: string): Promise<UploadState | null> {
  const id = String(videoId || '').trim();
  if (!id) return null;
  const r = await supabaseAdmin()
    .from(TABLE)
    .select('video_id, blog_id, size_bytes, content_type, declared, transaction, etags, status, expires_at, updated_at')
    .eq('video_id', id)
    .maybeSingle()
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { code?: string; message?: string } }));
  if (r.error) { quiet('metricool-upload-state:read', r.error, { videoId: id }); return null; }
  const row = r.data as {
    blog_id?: string | null; size_bytes?: number | string; content_type?: string; declared?: unknown; transaction?: unknown;
    etags?: unknown; status?: string; expires_at?: string | null; updated_at?: string | null;
  } | null;
  if (!row || (row.status !== 'uploading' && row.status !== 'hashing')) return null;
  const declared = Array.isArray(row.declared) ? (row.declared as DeclaredPart[]) : [];
  const tx = row.transaction && typeof row.transaction === 'object' ? (row.transaction as OpenedTransaction) : null;
  if (row.status === 'uploading' && (!declared.length || !tx)) return null;
  const etags: Record<string, string> = {};
  if (row.etags && typeof row.etags === 'object') {
    for (const [k, v] of Object.entries(row.etags as Record<string, unknown>)) if (typeof v === 'string' && v) etags[k] = v;
  }
  const exp = row.expires_at ? Date.parse(row.expires_at) : NaN;
  return {
    videoId: id,
    blogId: row.blog_id ?? null,
    sizeBytes: Number(row.size_bytes) || 0,
    contentType: String(row.content_type || 'video/mp4'),
    declared,
    tx,
    etags,
    expiresAt: Number.isFinite(exp) ? exp : null,
    status: row.status,
    updatedAt: row.updated_at ? Date.parse(row.updated_at) || Date.now() : Date.now(),
  };
}

/** Bank the slices measured so far. Called at every stop in the hashing pass, complete or not. */
export async function saveHashingProgress(videoId: string, input: { sizeBytes: number; declared: DeclaredPart[]; hashedBytes: number; blogId: string | null }): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .upsert({
      video_id: videoId,
      blog_id: input.blogId,
      size_bytes: input.sizeBytes,
      declared: input.declared,
      hashed_bytes: input.hashedBytes,
      status: 'hashing',
      transaction: null,
      etags: {},
      expires_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'video_id' })
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:hashing', r.error, { videoId });
}

/** Write a freshly opened upload (or a reopened one: the ETags start again). */
export async function saveUploadState(state: Omit<UploadState, 'status' | 'updatedAt' | 'tx'> & { tx: OpenedTransaction }): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .upsert({
      video_id: state.videoId,
      blog_id: state.blogId,
      size_bytes: state.sizeBytes,
      content_type: state.contentType,
      declared: state.declared,
      hashed_bytes: state.sizeBytes,
      transaction: state.tx,
      etags: state.etags,
      status: 'uploading',
      expires_at: state.expiresAt ? new Date(state.expiresAt).toISOString() : null,
      file_url: null,
      copy_id: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'video_id' })
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:write', r.error, { videoId: state.videoId });
}

/** Bank the ETags so far. Called after every batch; a lost request loses at most one batch. */
export async function saveUploadEtags(videoId: string, etags: Record<string, string>): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .update({ etags, updated_at: new Date().toISOString() })
    .eq('video_id', videoId)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:etags', r.error, { videoId });
}

/**
 * The signed addresses are no good (a slice or the completion was refused):
 * keep the hashes, drop the ETags, and mark the transaction expired so the
 * next pass reopens it and starts the slices again — without hashing again.
 */
export async function resetUploadState(videoId: string, error: string): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .update({ etags: {}, expires_at: new Date(0).toISOString(), last_error: String(error || '').slice(0, 1000), updated_at: new Date().toISOString() })
    .eq('video_id', videoId)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:reset', r.error, { videoId });
}

/** The upload completed: keep the row, marked done, so a re-run does not resume it. */
export async function finishUploadState(videoId: string, done: { fileUrl: string; copyId: string }): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .update({ status: 'done', file_url: done.fileUrl, copy_id: done.copyId, last_error: null, claimed_until: null, updated_at: new Date().toISOString() })
    .eq('video_id', videoId)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:finish', r.error, { videoId });
}

/**
 * The upload failed for a reason a retry will not fix (a slice refused, a
 * completion refused). Marked so the next pass starts clean rather than
 * resuming into the same refusal; the sentence is kept for the diagnosis.
 */
export async function failUploadState(videoId: string, error: string): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .update({ status: 'failed', last_error: String(error || '').slice(0, 1000), claimed_until: null, updated_at: new Date().toISOString() })
    .eq('video_id', videoId)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:fail', r.error, { videoId });
}

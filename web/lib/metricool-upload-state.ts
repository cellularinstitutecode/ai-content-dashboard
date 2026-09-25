// web/lib/metricool-upload-state.ts
// Where a Metricool upload that one request could not finish is kept.
//
// See supabase/metricool-uploads.sql. A multipart upload is a list of slices,
// each its own PUT with its own ETag, so it resumes at the first slice that
// has none. Everything below is best-effort: with the table missing (the SQL
// not yet run) or the database unreachable, every function answers as if
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
  declared: DeclaredPart[];
  tx: OpenedTransaction;
  /** partNumber -> ETag. */
  etags: Record<string, string>;
  /** Epoch ms after which the signed addresses are dead, or null when unknown. */
  expiresAt: number | null;
  status: 'uploading' | 'done' | 'failed';
  updatedAt: number;
};

const TABLE = 'metricool_uploads';

function quiet(where: string, error: { code?: string; message?: string } | null | undefined, ctx: Record<string, string>): void {
  if (!error) return;
  // A missing table is a migration not yet run, which the health check says
  // out loud; it is not worth an error per upload on top.
  if (isMissingSchema(error.code)) return;
  reportError(where, error, ctx);
}

/** The upload in progress for this video, or null. A finished or failed one is not resumed. */
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
  if (!row || row.status !== 'uploading') return null;
  const declared = Array.isArray(row.declared) ? (row.declared as DeclaredPart[]) : [];
  const tx = row.transaction && typeof row.transaction === 'object' ? (row.transaction as OpenedTransaction) : null;
  if (!declared.length || !tx) return null;
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
    status: 'uploading',
    updatedAt: row.updated_at ? Date.parse(row.updated_at) || Date.now() : Date.now(),
  };
}

/** Write a freshly opened upload (or a reopened one: the ETags start again). */
export async function saveUploadState(state: Omit<UploadState, 'status' | 'updatedAt'>): Promise<void> {
  const r = await supabaseAdmin()
    .from(TABLE)
    .upsert({
      video_id: state.videoId,
      blog_id: state.blogId,
      size_bytes: state.sizeBytes,
      content_type: state.contentType,
      declared: state.declared,
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
    .update({ status: 'done', file_url: done.fileUrl, copy_id: done.copyId, last_error: null, updated_at: new Date().toISOString() })
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
    .update({ status: 'failed', last_error: String(error || '').slice(0, 1000), updated_at: new Date().toISOString() })
    .eq('video_id', videoId)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));
  quiet('metricool-upload-state:fail', r.error, { videoId });
}

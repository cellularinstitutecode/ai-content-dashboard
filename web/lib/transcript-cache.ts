// The transcript of a video, kept so it is only ever paid for once.
//
// The reels in the sheet run to 149 MB and beyond, and pulling one down from
// Drive takes most of a 60-second function before ffmpeg or the transcriber
// have started. So the full chain — download, extract, transcribe, keyword
// brief, write the copy — does not reliably fit in one invocation on this
// plan, and until now a run that overran discarded the download and the
// transcription spend with it. Pressing Prepare again bought the same timeout
// a second time, at the same cost.
//
// This makes the work RESUMABLE rather than faster: the expensive half happens
// once, and every later attempt on the same video skips it. A first attempt
// that times out is no longer wasted — it is the first half, done.
//
// Keyed on the video, not the sheet row, so the Prepare button and the
// automatic sweep share one copy. Failures here are logged and swallowed on
// purpose: a cache that cannot be reached must slow the pipeline down, never
// stop it.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type CachedTranscript = {
  text: string;
  source: string;
  language: string | null;
  title: string | null;
};

/** A transcript already paid for, or null. Never throws. */
export async function cachedTranscript(videoId: string): Promise<CachedTranscript | null> {
  const id = String(videoId || '').trim();
  if (!id) return null;
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .select('text, source, language, title')
    .eq('video_id', id)
    .maybeSingle()
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (r.error) {
    // Not fatal, but not silent either: a cache that is quietly missing looks
    // exactly like a pipeline that is quietly slow and expensive.
    reportError('transcript-cache:read', r.error, { videoId: id });
    return null;
  }
  const row = r.data as { text?: string; source?: string; language?: string | null; title?: string | null } | null;
  const text = String(row?.text || '').trim();
  if (!text) return null;
  return { text, source: String(row?.source || 'drive'), language: row?.language ?? null, title: row?.title ?? null };
}

/** Keep a transcript for next time. Never throws. */
export async function cacheTranscript(videoId: string, t: CachedTranscript): Promise<void> {
  const id = String(videoId || '').trim();
  const text = String(t.text || '').trim();
  if (!id || !text) return;
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .upsert({
      video_id: id,
      source: t.source || 'drive',
      language: t.language,
      title: t.title,
      text,
      chars: text.length,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'video_id' })
    .then((x) => x, (e: unknown) => ({ error: e as { message?: string } }));
  if (r.error) reportError('transcript-cache:write', r.error, { videoId: id });
}

/**
 * The public Drive copy already made for a video, if there is one.
 *
 * Metricool cannot fetch an ordinary Drive link, so a video attached to a post is copied
 * into the app's folder and that copy is opened to anyone holding the URL. It used to be
 * made once per run — re-preparing a row made another — and nothing could delete any of
 * them, so the folder filled with world-readable copies of the clinic's footage that
 * nothing could trace back to a row.
 *
 * Never throws: an unreachable cache must cost a duplicate copy, not the post.
 */
export async function cachedPublicCopy(videoId: string): Promise<{ id: string; url: string } | null> {
  const key = String(videoId || '').trim();
  if (!key) return null;
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .select('public_copy_id, public_copy_url')
    .eq('video_id', key)
    .maybeSingle()
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (r.error) {
    reportError('transcript-cache:copy-read', r.error, { videoId: key });
    return null;
  }
  const row = r.data as { public_copy_id?: string | null; public_copy_url?: string | null } | null;
  const id = String(row?.public_copy_id || '').trim();
  const url = String(row?.public_copy_url || '').trim();
  return id && url ? { id, url } : null;
}

/**
 * Remember the copy, or forget it once it has been deleted.
 *
 * Upsert rather than update: a video whose copy is made before its transcript is cached
 * has no row yet, and losing the record would put us straight back to making a second
 * copy on the next run. `text` is required by the table, so an empty string stands in
 * until the transcript itself arrives and replaces it.
 */
export async function rememberPublicCopy(videoId: string, copy: { id: string; url: string } | null): Promise<void> {
  const key = String(videoId || '').trim();
  if (!key) return;
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .upsert({
      video_id: key,
      text: '',
      public_copy_id: copy?.id ?? null,
      public_copy_url: copy?.url ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'video_id', ignoreDuplicates: false })
    .then((x) => x, (e: unknown) => ({ error: e as { message?: string } }));
  if (r.error) reportError('transcript-cache:copy-write', r.error, { videoId: key });
}

/**
 * Forget a copy that has been deleted, found by the COPY's own id.
 *
 * The cache is keyed on the source video, not on the copy, so a caller holding only the
 * deleted file's id cannot address the row directly. Clearing it matters: leaving the id
 * behind would have the next run hand Metricool a URL for a file that no longer exists,
 * which is worse than making a fresh copy.
 */
export async function forgetPublicCopy(copyFileId: string): Promise<void> {
  const id = String(copyFileId || '').trim();
  if (!id) return;
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .update({ public_copy_id: null, public_copy_url: null, updated_at: new Date().toISOString() })
    .eq('public_copy_id', id)
    .then((x) => x, (e: unknown) => ({ error: e as { message?: string } }));
  if (r.error) reportError('transcript-cache:copy-forget', r.error, { copyFileId: id });
}

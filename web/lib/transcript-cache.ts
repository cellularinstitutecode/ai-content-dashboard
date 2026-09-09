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

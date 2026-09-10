// web/lib/media-library.ts
// The videos a post can actually carry.
//
// Metricool cannot fetch an ordinary Google Drive link — the clinic's footage
// is private, and a post handed that URL gets a permission wall. What it CAN
// fetch is the world-readable copy `completeRow` makes when a row is prepared,
// recorded against the source video in video_transcripts.public_copy_url
// (lib/transcript-cache.ts).
//
// So this module answers one question: which videos already have such a copy?
// It only ever READS. Browsing the picker must never create a public copy of a
// clinic's footage — pressing Prepare on a row is the single action that does
// that, and it stays that way.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type ShareableVideo = {
  /** The SOURCE video's id — a Drive file id, or a YouTube video id. */
  videoId: string;
  title: string;
  /** The public copy's URL. This is what goes to Metricool as `mediaUrl`. */
  url: string;
  source: string;
  updatedAt: string;
};

/**
 * Videos with a shareable copy, newest first.
 *
 * Never throws. supabase-js RESOLVES a failed query rather than rejecting it,
 * which has bitten this codebase repeatedly: an unchecked `.error` turns an
 * outage into "you have no videos", and an empty picker is indistinguishable
 * from a broken one. The error is reported and an empty list returned, and the
 * route says which of the two happened.
 */
export async function listShareableVideos(limit = 40): Promise<{ videos: ShareableVideo[]; failed: boolean }> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .select('video_id, title, source, public_copy_url, updated_at')
    .not('public_copy_url', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(capped)
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));

  if (r.error) {
    reportError('media-library:list', r.error);
    return { videos: [], failed: true };
  }

  const rows = (r.data || []) as {
    video_id?: string | null; title?: string | null; source?: string | null;
    public_copy_url?: string | null; updated_at?: string | null;
  }[];

  const videos: ShareableVideo[] = [];
  for (const row of rows) {
    const url = String(row.public_copy_url || '').trim();
    const videoId = String(row.video_id || '').trim();
    // A row can carry an id with no copy if a previous copy was forgotten;
    // `is not null` would still return it if the column held an empty string.
    if (!url || !videoId) continue;
    videos.push({
      videoId,
      title: String(row.title || '').trim() || 'Untitled video',
      url,
      source: String(row.source || 'drive').trim(),
      updatedAt: String(row.updated_at || ''),
    });
  }
  return { videos, failed: false };
}

// web/lib/media-library.ts
// The videos a post can actually carry.
//
// Metricool cannot fetch an ordinary Google Drive link — the clinic's footage
// is private, and a post handed that URL gets a permission wall. What it CAN
// fetch is the world-readable copy `completeRow` makes when a row is prepared,
// recorded against the source video in video_transcripts.public_copy_url
// (lib/transcript-cache.ts).
//
// Two questions, and the difference between them matters:
//
//   listShareableVideos  — which videos ALREADY have such a copy? Read-only.
//                          Browsing the picker never creates one.
//   ensureShareableVideo — make one for this video if it has none. A real side
//                          effect, reached only from a button that says so.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { publicVideoCopy } from '@/lib/drive';
import { cachedPublicCopy, rememberPublicCopy } from '@/lib/transcript-cache';
import { parseDriveFileId } from '@/lib/drive-url';
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

/**
 * Make sure this video CAN be attached, and say where it lives.
 *
 * "Use in post" used to hand over the caption and an empty media slot whenever
 * the row had never been prepared, which from the outside looks exactly like a
 * broken button: the text arrives, the video does not, and nothing says why.
 * The missing thing is the world-readable Drive copy — the clinic's own file is
 * private, so no network can fetch it.
 *
 * So this makes the copy when it is missing. That is a real side effect and the
 * button that calls it says so in as many words before it runs; it is not done
 * on a page load, a hover, or the picker merely being opened. The copy is made
 * once per source video and remembered, so pressing the button twice costs one
 * database read.
 */
export async function ensureShareableVideo(videoLink: string, title?: string | null): Promise<
  | { ok: true; url: string; fileId: string; created: boolean }
  | { ok: false; reason: 'not_drive' | 'failed'; message: string }
> {
  const fileId = parseDriveFileId(String(videoLink || ''));
  if (!fileId) {
    return {
      ok: false,
      reason: 'not_drive',
      message: 'That row has no Google Drive video, so there is nothing to attach.',
    };
  }

  const known = await cachedPublicCopy(fileId);
  if (known?.url) return { ok: true, url: known.url, fileId: known.id, created: false };

  try {
    const name = String(title || 'video').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 80) + '.mp4';
    const made = await publicVideoCopy(fileId, name);
    // Remembered immediately: without this, the next press makes ANOTHER
    // world-readable copy of the clinic's footage, and nothing here can delete one.
    await rememberPublicCopy(fileId, { id: made.fileId, url: made.url });
    return { ok: true, url: made.url, fileId: made.fileId, created: true };
  } catch (e) {
    reportError('media-library:ensure-copy', e, { fileId });
    return {
      ok: false,
      reason: 'failed',
      message: 'We could not make a shareable copy of that video just now. Try again, or press Prepare on the row.',
    };
  }
}

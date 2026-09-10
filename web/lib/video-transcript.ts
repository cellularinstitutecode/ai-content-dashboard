// web/lib/video-transcript.ts
// One ladder, tried in order, for "what was said in this video".
//
//   1. A transcript somebody pasted. Always wins — a person who has typed the
//      words is more authoritative than any machine, and it costs nothing.
//   2. A YouTube link. YouTube's own caption track is free, instant and exact
//      (lib/youtube-transcript.ts). Rodrigo's sheet keeps the published URL in
//      its YOUTUBE column, so a video that has been published already has this.
//   3. The Drive .mp4 in the LINK VIDEO column, through speech-to-text
//      (lib/media-transcript.ts). Costs about a cent and takes a few seconds.
//
// Both the Video Library button and the automatic sweep call this, so the
// two can never disagree about where a transcript comes from.
import 'server-only';

import { parseVideoUrl } from '@/lib/composer';
import { parseDriveFileId } from '@/lib/drive-url';
import { fetchYouTubeTranscript } from '@/lib/youtube-transcript';
import { transcribeDriveMedia, type MediaFailure } from '@/lib/media-transcript';
import { cacheTranscript, cachedTranscript } from '@/lib/transcript-cache';

export type TranscriptOrigin = 'pasted' | 'youtube' | 'drive';

export type ResolvedTranscript =
  | {
      ok: true; text: string; origin: TranscriptOrigin; language: string | null; title: string | null; videoId: string | null;
      /**
       * Is this transcript safe from a timeout — either it came FROM the cache, or it was
       * just written there successfully?
       *
       * False means the expensive half will have to be done again, and any advice to
       * "press Prepare again" would be a lie. On a database missing the table this is
       * false every time, which is precisely the case that had a person pressing a button
       * that could never work.
       */
      banked: boolean;
    }
  | { ok: false; reason: string; message: string; title: string | null; /** True when pasting the words is the way forward. */ needsPaste: boolean };

export type TranscriptInput = {
  /** The link on the row: a Drive file, or a YouTube URL. */
  url?: string | null;
  /** The sheet's YOUTUBE column, when it holds a published URL. */
  youtubeUrl?: string | null;
  /** Words a person typed. Wins over everything. */
  pasted?: string | null;
};

const MIN_CHARS = 40;

/**
 * A video's transcript, from the cache when it has been paid for before.
 *
 * The cache is checked before the DOWNLOAD, not merely before the
 * transcription: on a 149 MB reel the download is the expensive part, and
 * skipping it is what turns a second attempt from a repeat of the first
 * timeout into a run that finishes in seconds.
 */
async function transcribeOrRecall(fileId: string): Promise<
  { ok: true; text: string; language: string | null; name: string; banked: boolean }
  | { ok: false; reason: MediaFailure; message: string }
> {
  const hit = await cachedTranscript(fileId);
  if (hit) {
    // Already safe by definition — it came out of the cache.
    return { ok: true, text: hit.text, language: hit.language, name: hit.title || '', banked: true };
  }
  const t = await transcribeDriveMedia(fileId);
  if (!t.ok) return t;
  // Stored before anything else is attempted. What follows this — the keyword
  // brief and the copy — is what usually runs the function out of time, and
  // storing afterwards would be storing it never.
  //
  // Whether it actually landed is carried onward. It used to be discarded, and a failed
  // write then looked exactly like a successful one.
  const banked = await cacheTranscript(fileId, { text: t.text, source: 'drive', language: t.language ?? null, title: t.name || null });
  return { ok: true, text: t.text, language: t.language ?? null, name: t.name, banked };
}

export async function resolveTranscript(input: TranscriptInput): Promise<ResolvedTranscript> {
  const pasted = String(input.pasted || '').replace(/\s+/g, ' ').trim();
  if (pasted) {
    if (pasted.length < MIN_CHARS) {
      return { ok: false, reason: 'transcript_too_short', message: 'That transcript is too short to write from.', title: null, needsPaste: true };
    }
    // Typed by a person: there is no expensive half to lose.
    return { ok: true, text: pasted, origin: 'pasted', language: null, title: null, videoId: null, banked: true };
  }

  const url = String(input.url || '').trim();
  const youtube = String(input.youtubeUrl || '').trim();

  // 2) A YouTube link, from either field.
  for (const candidate of [youtube, url]) {
    if (!candidate) continue;
    const parsed = parseVideoUrl(candidate);
    if (!parsed.ok || parsed.source !== 'YouTube') continue;
    const t = await fetchYouTubeTranscript(parsed.id);
    if (t.ok) {
      // Captions are a small fetch, not a download and a transcription: re-doing them
      // costs a second, so a retry is honest advice here whatever the cache did.
      return { ok: true, text: t.text.replace(/\s+/g, ' ').trim(), origin: 'youtube', language: t.language, title: t.title, videoId: parsed.id, banked: true };
    }
    // A YouTube link with no captions is not the end: the Drive file below may
    // still carry the audio. Only when there is no Drive file either does this
    // become the answer.
    if (!parseDriveFileId(url)) {
      return { ok: false, reason: t.reason, message: t.message, title: t.title, needsPaste: true };
    }
    break;
  }

  // 3) The Drive recording.
  const fileId = parseDriveFileId(url);
  if (fileId) {
    const t = await transcribeOrRecall(fileId);
    if (t.ok) {
      const text = t.text.trim();
      if (text.length < MIN_CHARS) {
        return { ok: false, reason: 'transcript_too_short', message: 'Only a few words could be heard in that video.', title: t.name, needsPaste: true };
      }
      return { ok: true, text, origin: 'drive', language: t.language, title: stripExtension(t.name), videoId: fileId, banked: t.banked };
    }
    // 'too_large' and 'empty' are the cases a person can fix by pasting;
    // 'not_configured' and 'unreachable' are ours to fix, and pasting is a
    // workaround rather than the answer.
    return {
      ok: false,
      reason: t.reason,
      message: t.message,
      title: null,
      needsPaste: t.reason === 'too_large' || t.reason === 'empty' || t.reason === 'not_media',
    };
  }

  return {
    ok: false,
    reason: 'no_source',
    message: url
      ? 'That link is neither a YouTube video nor a Google Drive file, so there is nothing to transcribe. Paste the transcript instead.'
      : 'This row has no video link yet.',
    title: null,
    needsPaste: Boolean(url),
  };
}

export function stripExtension(name: string | null): string | null {
  if (!name) return null;
  return name.replace(/\.(mp4|mov|webm|mpeg|mp3|m4a|wav)$/i, '').replace(/[_]+/g, ' ').trim() || null;
}

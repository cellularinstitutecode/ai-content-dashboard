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
import { transcribeDriveMedia } from '@/lib/media-transcript';

export type TranscriptOrigin = 'pasted' | 'youtube' | 'drive';

export type ResolvedTranscript =
  | { ok: true; text: string; origin: TranscriptOrigin; language: string | null; title: string | null; videoId: string | null }
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

export async function resolveTranscript(input: TranscriptInput): Promise<ResolvedTranscript> {
  const pasted = String(input.pasted || '').replace(/\s+/g, ' ').trim();
  if (pasted) {
    if (pasted.length < MIN_CHARS) {
      return { ok: false, reason: 'transcript_too_short', message: 'That transcript is too short to write from.', title: null, needsPaste: true };
    }
    return { ok: true, text: pasted, origin: 'pasted', language: null, title: null, videoId: null };
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
      return { ok: true, text: t.text.replace(/\s+/g, ' ').trim(), origin: 'youtube', language: t.language, title: t.title, videoId: parsed.id };
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
    const t = await transcribeDriveMedia(fileId);
    if (t.ok) {
      const text = t.text.trim();
      if (text.length < MIN_CHARS) {
        return { ok: false, reason: 'transcript_too_short', message: 'Only a few words could be heard in that video.', title: t.name, needsPaste: true };
      }
      return { ok: true, text, origin: 'drive', language: t.language, title: stripExtension(t.name), videoId: fileId };
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

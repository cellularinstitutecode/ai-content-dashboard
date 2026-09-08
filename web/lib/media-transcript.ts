// web/lib/media-transcript.ts
// The words in a video that has no captions.
//
// lib/youtube-transcript.ts covers everything published to YouTube: the
// caption track is free, instant and exact. Rodrigo's video sheet is not that
// — its LINK VIDEO column holds Drive .mp4 files, which carry no captions at
// all. This module is the other half: the file is pulled from Drive with the
// service account the dashboard already uses, and handed to OpenAI's
// transcription endpoint.
//
// Deliberately narrow. It transcribes, and it reports precisely why it could
// not; deciding what to do about a refusal belongs to the caller, which can
// fall back to a YouTube link or ask a person to paste the words.
import 'server-only';

import { downloadDriveMedia, TRANSCRIBE_MAX_BYTES } from '@/lib/google-sources';
import { filenameFor } from '@/lib/media-filename';
import { redact } from '@/lib/report';

export type MediaTranscript =
  | { ok: true; text: string; language: string | null; source: 'drive'; name: string; sizeBytes: number }
  | { ok: false; reason: 'not_configured' | 'not_media' | 'too_large' | 'unreachable' | 'empty' | 'failed'; message: string };

/** whisper-1 takes verbose_json (and so reports the language it heard); the gpt-4o transcribers do not. */
const MODEL = () => process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

export function transcriptionConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Transcribe one Drive-hosted video or audio file.
 *
 * @param fileId a Drive file id (lib/drive-url.ts turns a pasted link into one)
 */
export async function transcribeDriveMedia(fileId: string, opts: { timeoutMs?: number } = {}): Promise<MediaTranscript> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { ok: false, reason: 'not_configured', message: 'Automatic transcription needs OPENAI_API_KEY, which is not set on this deployment.' };
  }

  const got = await downloadDriveMedia(fileId, TRANSCRIBE_MAX_BYTES);
  if (!got.ok) return { ok: false, reason: got.reason, message: got.message };
  const { bytes, contentType, name, sizeBytes } = got.media;

  const model = MODEL();
  const form = new FormData();
  // A filename with a real extension matters: the endpoint decides how to
  // demux from it, and a name like "Reel_PEMF" with none is rejected outright.
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filenameFor(name, contentType));
  form.append('model', model);
  if (/^whisper/.test(model)) form.append('response_format', 'verbose_json');
  // No `language` hint on purpose. The clinic films in both Spanish and
  // English, sometimes in the same reel, and a wrong hint makes Whisper
  // translate rather than transcribe.

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key },
      body: form,
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: 'failed', message: 'The transcriber refused this file (HTTP ' + res.status + '). ' + redact(body.slice(0, 200)) };
    }
    const j = await res.json().catch(() => null) as { text?: string; language?: string } | null;
    const text = String(j?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'empty', message: 'The transcriber heard no speech in that video.' };
    return { ok: true, text, language: j?.language || null, source: 'drive', name, sizeBytes };
  } catch (e) {
    const why = e instanceof Error && e.name === 'AbortError' ? 'it took too long' : redact(e instanceof Error ? e.message : 'error');
    return { ok: false, reason: 'unreachable', message: 'The transcriber could not be reached (' + why + ').' };
  } finally {
    clearTimeout(to);
  }
}

// web/lib/media-transcript.ts
// The words in a video that has no captions.
//
// lib/youtube-transcript.ts covers everything published to YouTube: the
// caption track is free, instant and exact. Rodrigo's video sheet is not that
// — its LINK VIDEO column holds Drive .mp4 files, which carry no captions at
// all, and which are far too large to hand to a transcriber whole. So the file
// is streamed from Drive with the service account the dashboard already uses,
// its audio track is lifted out (lib/audio-extract.ts), and only that couple
// of megabytes is uploaded.
//
// Deliberately narrow. It transcribes, and it reports precisely why it could
// not; deciding what to do about a refusal belongs to the caller, which can
// fall back to a YouTube link or ask a person to paste the words.
import 'server-only';

import { openAsBlob } from 'node:fs';

import { extractAudio, extractAudioFromUrl, ffmpegAvailable, type ExtractedAudio } from '@/lib/audio-extract';
import { driveMediaAddress, driveMediaStream, probeDriveMedia } from '@/lib/google-sources';
import { megabytes, routeFor } from '@/lib/media-route';
import { downloadBudgetMs, streamExtractBudgetMs, transcribeBudgetMs } from '@/lib/prepare-budget';
import { redact } from '@/lib/report';

/** Why a recording could not be turned into words. Named so callers that wrap
 *  this (the transcript ladder, the cache) can pass a failure through unchanged. */
// 'out_of_time' is the one failure that a second press genuinely fixes: the
// work was sound, the clock was not.
export type MediaFailure = 'not_configured' | 'not_media' | 'too_large' | 'unreachable' | 'empty' | 'failed' | 'out_of_time';

export type MediaTranscript =
  | { ok: true; text: string; language: string | null; source: 'drive'; name: string; sizeBytes: number }
  | { ok: false; reason: MediaFailure; message: string };

/** whisper-1 takes verbose_json (and so reports the language it heard); the gpt-4o transcribers do not. */
const MODEL = () => process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

export function transcriptionConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) && ffmpegAvailable();
}

/**
 * Transcribe one Drive-hosted video or audio file.
 *
 * @param fileId a Drive file id (lib/drive-url.ts turns a pasted link into one)
 */
export async function transcribeDriveMedia(
  fileId: string,
  opts: {
    timeoutMs?: number;
    /**
     * When the platform will kill the function, as a clock reading.
     *
     * Given one, the download is refused up front when there is not enough
     * time left to also extract and transcribe — and the transfer itself gets
     * a real deadline. Without it the download ran unguarded and the request
     * died mid-transfer with nothing said and nothing kept.
     */
    deadlineAt?: number;
  } = {},
): Promise<MediaTranscript> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { ok: false, reason: 'not_configured', message: 'Automatic transcription needs OPENAI_API_KEY, which is not set on this deployment.' };
  }

  // Metadata first: one request rules out a file that is not a recording, or
  // one too big to pull down, before any of it is transferred.
  // No size ceiling on the probe at all — it checks only that the file is
  // reachable and is a recording. Size policy lives in exactly one place now
  // (lib/media-route.ts), because it stopped being a yes/no: under the
  // scratch-disk cap the video is staged as before, over it ffmpeg reads it
  // where it lives, and only past what can cross the wire in one request is it
  // actually refused. Two places deciding that would drift apart.
  const probe = await probeDriveMedia(fileId, Number.POSITIVE_INFINITY);
  if (!probe.ok) return { ok: false, reason: probe.reason, message: probe.message };

  const route = routeFor(probe.sizeBytes);
  if (route === 'too_large') {
    return {
      ok: false,
      reason: 'too_large',
      message: 'That video is ' + megabytes(probe.sizeBytes) + ', too much to read inside one request however it is fetched. Paste the transcript instead.',
    };
  }

  // The clock, BEFORE the expensive step rather than after it.
  //
  // A refusal that names the reason is worth more than a kill that says
  // nothing: this is the difference between "there were 18 seconds left, which
  // is not enough to fetch 149 MB and transcribe it" and a blank timeout.
  const deadlineAt = opts.deadlineAt ?? 0;
  const leftNow = deadlineAt > 0 ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY;
  const forDownload = deadlineAt > 0 ? downloadBudgetMs(leftNow) : 40_000;
  if (forDownload <= 0) {
    const mb = probe.sizeBytes ? (probe.sizeBytes / 1024 / 1024).toFixed(0) + ' MB' : 'that video';
    return {
      ok: false,
      reason: 'out_of_time',
      message: 'Only ' + Math.max(0, Math.round(leftNow / 1000)) + ' seconds were left on this request, which is not enough to fetch ' + mb +
        ' and transcribe it. Press Prepare again to start with a full clock.',
    };
  }

  // Big enough that staging it would need more scratch disk than the function
  // has: ffmpeg opens the Drive URL itself and writes only the mp3.
  if (route === 'stream') {
    const address = await driveMediaAddress(fileId);
    // Not forDownload: that holds back time for a separate extraction step this
    // path does not have, and these are the files with none to spare.
    const forStream = deadlineAt > 0 ? streamExtractBudgetMs(deadlineAt - Date.now()) : 120_000;
    const streamed = await extractAudioFromUrl(address.url, address.token, { timeoutMs: forStream });
    if (!streamed.ok) {
      // Mapped exactly as the disk path maps the same failures below, so which
      // route a video took never changes how its failure is classified — and
      // in particular never changes whether lib/failure-kind.ts will retry it.
      const reason = streamed.reason === 'no_audio' ? 'empty'
        : streamed.reason === 'too_long' ? 'too_large'
        : streamed.reason === 'not_available' ? 'not_configured'
        : 'failed';
      return { ok: false, reason, message: streamed.message };
    }
    return transcribeExtracted(streamed.audio, probe.name, key, deadlineAt);
  }

  let res: Response;
  try {
    res = await driveMediaStream(fileId, forDownload);
  } catch (e) {
    // A transfer that hit the deadline is a different problem from Drive being
    // unreachable, and pretending otherwise sends somebody to check sharing
    // permissions that are perfectly fine.
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const mb = probe.sizeBytes ? (probe.sizeBytes / 1024 / 1024).toFixed(0) + ' MB' : 'that video';
      return {
        ok: false,
        reason: 'out_of_time',
        message: 'Downloading ' + mb + ' from Drive ran past the ' + Math.round(forDownload / 1000) + ' seconds this request could give it.',
      };
    }
    return { ok: false, reason: 'unreachable', message: 'Drive did not hand over that file just now.' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'unreachable', message: 'Drive refused the download (HTTP ' + res.status + ').' };
  }

  const extracted = await extractAudio(res.body, probe.name);
  if (!extracted.ok) {
    // 'no_audio' is a b-roll clip with nothing said in it — the caller treats
    // that as "a person should write this one", not as a fault.
    const reason = extracted.reason === 'no_audio' ? 'empty'
      : extracted.reason === 'too_long' ? 'too_large'
      : extracted.reason === 'not_available' ? 'not_configured'
      : 'failed';
    return { ok: false, reason, message: extracted.message };
  }

  return transcribeExtracted(extracted.audio, probe.name, key, deadlineAt, opts.timeoutMs);
}

/**
 * Send an already-extracted mp3 to the transcriber.
 *
 * Split out when ffmpeg gained a second way to produce that mp3 (reading the
 * Drive URL directly, for files too big to stage on the scratch disk). Both
 * routes end with the same file on disk and the same work to do with it, and
 * the alternative was a second copy of the budget arithmetic, the multipart
 * upload, the abort handling and the release() in the finally — which is
 * exactly the kind of duplication that drifts.
 */
async function transcribeExtracted(
  audio: ExtractedAudio,
  name: string,
  key: string,
  deadlineAt: number,
  timeoutMs?: number,
): Promise<MediaTranscript> {
  const model = MODEL();
  const ctl = new AbortController();
  // What is left after the download actually finished, not what was planned
  // for it. A download that took twice as long as expected must not hand the
  // transcriber a budget the function no longer has.
  const forTranscribe = timeoutMs
    ?? (deadlineAt > 0 ? transcribeBudgetMs(deadlineAt - Date.now()) : 30_000);
  if (forTranscribe <= 0) {
    await audio.release();
    return {
      ok: false,
      reason: 'out_of_time',
      message: 'The download used the time this request had, leaving none to transcribe. Press Prepare again to start with a full clock.',
    };
  }
  const to = setTimeout(() => ctl.abort(), forTranscribe);
  try {
    const form = new FormData();
    // openAsBlob streams the file off disk rather than reading it into memory.
    form.append('file', await openAsBlob(audio.path, { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', model);
    if (/^whisper/.test(model)) form.append('response_format', 'verbose_json');
    // No `language` hint on purpose. The clinic films in both Spanish and
    // English, sometimes in the same reel, and a wrong hint makes Whisper
    // translate rather than transcribe.

    const out = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key },
      body: form,
      signal: ctl.signal,
    });
    if (!out.ok) {
      const body = await out.text().catch(() => '');
      return { ok: false, reason: 'failed', message: 'The transcriber refused this file (HTTP ' + out.status + '). ' + redact(body.slice(0, 200)) };
    }
    const j = await out.json().catch(() => null) as { text?: string; language?: string } | null;
    const text = String(j?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'empty', message: 'The transcriber heard no speech in that video.' };
    return { ok: true, text, language: j?.language || null, source: 'drive', name, sizeBytes: audio.sizeBytes };
  } catch (e) {
    const why = e instanceof Error && e.name === 'AbortError' ? 'it took too long' : redact(e instanceof Error ? e.message : 'error');
    return { ok: false, reason: 'unreachable', message: 'The transcriber could not be reached (' + why + ').' };
  } finally {
    clearTimeout(to);
    // The scratch files go whatever happened above.
    await audio.release();
  }
}

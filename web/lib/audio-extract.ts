// web/lib/audio-extract.ts
// The audio track of a video, on its own.
//
// The clinic's reels are 76–283 MB, and OpenAI's transcription endpoint
// refuses anything over 25 MB — which for a while meant the automatic path
// could not read a single video in the sheet. The fix is not to work around
// the ceiling but to stop hitting it: a three-minute reel's SPEECH is a couple
// of megabytes, and the other 190 are pixels the transcriber would throw away
// on arrival.
//
// So the video is streamed to the function's scratch disk, ffmpeg lifts out
// the audio as 16 kHz mono — exactly what the transcriber resamples to anyway,
// so nothing it would have used is lost — and only that is uploaded.
//
// Everything here is temporary: both files are deleted on the way out, on
// every path including failure.
import 'server-only';

import { execFile } from 'node:child_process';
import { constants as FS, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import ffmpegStatic from 'ffmpeg-static';

import { redact, reportError } from '@/lib/report';

const run = promisify(execFile);

/**
 * The ffmpeg binary, at a path it can actually be RUN from.
 *
 * ffmpeg-static installs an executable file, and next.config.mjs traces it
 * into the deployed function — but the serverless bundler does not always
 * carry the execute bit across, and the application directory is read-only at
 * runtime, so it cannot simply be chmod'ed where it lies. The symptom is
 * brutal to diagnose: spawn fails with EACCES before ffmpeg starts, so there
 * is no ffmpeg stderr at all and the failure reads as "the audio could not be
 * read" with nothing after it.
 *
 * So: use it in place when it is executable, and otherwise copy it once into
 * /tmp — the one writable directory — and mark it executable there. Cached per
 * process, so the copy happens at most once per cold start.
 */
let resolvedBinary: string | null = null;

/** Forget the cached path. Only the test needs this; a process never changes binaries. */
export function resetFfmpegBinary(): void {
  resolvedBinary = null;
}

export async function ffmpegBinary(): Promise<string | null> {
  if (resolvedBinary) return resolvedBinary;
  // FFMPEG_PATH is the escape hatch for a deployment where the packaged binary
  // never arrived at all — ffmpeg-static fetches it in a postinstall step, and
  // a build that skips scripts leaves the package exporting a path to nothing.
  const src = process.env.FFMPEG_PATH || ffmpegStatic;
  if (!src) return null;

  try {
    await access(src, FS.X_OK);
    resolvedBinary = src;
    return src;
  } catch { /* not executable where it sits — fall through to the /tmp copy */ }

  const dest = path.join(tmpdir(), 'ffmpeg-static-bin');
  try {
    // A previous invocation on this same warm instance already did the copy.
    await access(dest, FS.X_OK);
    resolvedBinary = dest;
    return dest;
  } catch { /* first time on this instance */ }

  try {
    await copyFile(src, dest);
    await chmod(dest, 0o755);
    resolvedBinary = dest;
    return dest;
  } catch (e) {
    reportError('audio-extract:binary', e, { src, dest });
    return null;
  }
}

/** What the transcription endpoint accepts. The extracted audio must fit inside it. */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 16 kHz mono MP3 at 64 kbps.
 *
 * The sample rate is the transcriber's own working rate, so a higher one buys
 * nothing. The bitrate is generous FOR that rate — the clinic's vocabulary is
 * "exosomes", "plasmapheresis", "EBOO", and speech recognition is at its worst
 * on exactly those words, so this is not the place to shave bytes. Even so it
 * fits about 50 minutes of speech inside the 25 MB ceiling; the longest thing
 * in the sheet is a few minutes.
 */
export const FFMPEG_ARGS = (input: string, output: string): string[] => [
  '-nostdin',
  '-loglevel', 'error',
  '-y',
  '-i', input,
  '-vn',              // drop the video: it is the 190 MB nobody needs
  '-ac', '1',         // mono
  '-ar', '16000',     // the rate the transcriber works at
  '-c:a', 'libmp3lame',
  '-b:a', '64k',
  output,
];

export type ExtractedAudio = {
  /** Where the audio sits on disk. Valid until release() is called. */
  path: string;
  sizeBytes: number;
  /** Deletes the scratch directory. Always call it; it never throws. */
  release: () => Promise<void>;
};

export type ExtractResult =
  | { ok: true; audio: ExtractedAudio }
  | { ok: false; reason: 'not_available' | 'too_long' | 'no_audio' | 'failed'; message: string };

export function ffmpegAvailable(): boolean {
  return Boolean(ffmpegStatic);
}

/**
 * Pull the audio out of a video stream.
 *
 * @param body      the video, as it arrives from Drive
 * @param sourceName the file's name, only for choosing an extension ffmpeg can demux
 */
export async function extractAudio(
  body: ReadableStream<Uint8Array> | null,
  sourceName: string,
  opts: { timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const ffmpeg = await ffmpegBinary();
  if (!ffmpeg) {
    return { ok: false, reason: 'not_available', message: 'The audio extractor is not runnable on this deployment.' };
  }
  if (!body) {
    return { ok: false, reason: 'failed', message: 'Drive sent no data for that file.' };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'chi-audio-'));
  const release = async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); };
  const source = path.join(dir, 'source' + sourceExtension(sourceName));
  const output = path.join(dir, 'audio.mp3');

  try {
    // Written as it arrives. The alternative — one Buffer — is the whole video
    // resident in function memory, which for a 283 MB reel is most of it.
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(source));

    try {
      await run(ffmpeg, FFMPEG_ARGS(source, output), {
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (e) {
      const err = e as { stderr?: string; code?: string | number; killed?: boolean; message?: string };
      const stderr = String(err?.stderr || '');
      // A video with no audio track at all is a b-roll clip, not a broken file,
      // and the caller should say so rather than report an error.
      if (/does not contain any stream|Output file (#0 )?does not contain/i.test(stderr)) {
        await release();
        return { ok: false, reason: 'no_audio', message: 'That video has no sound to transcribe.' };
      }
      await release();
      // Say WHY. ffmpeg failing and ffmpeg never starting are different
      // problems with identical stderr (none), and reporting only stderr made
      // a spawn failure indistinguishable from a corrupt video — which cost a
      // deployment's worth of guessing.
      const why = stderr.trim()
        ? redact(stderr.slice(0, 200))
        : err?.killed
          ? 'it took too long and was stopped'
          : 'the extractor could not be started (' + String(err?.code || err?.message || 'unknown') + ')';
      reportError('audio-extract:ffmpeg', e, { binary: ffmpeg, code: String(err?.code || '') });
      return { ok: false, reason: 'failed', message: 'The audio could not be read out of that video: ' + why + '.' };
    }

    const info = await stat(output).catch(() => null);
    if (!info || info.size === 0) {
      await release();
      return { ok: false, reason: 'no_audio', message: 'That video has no sound to transcribe.' };
    }
    if (info.size > AUDIO_MAX_BYTES) {
      await release();
      return {
        ok: false,
        reason: 'too_long',
        message: 'That recording is too long to transcribe in one piece (over ' + Math.floor(AUDIO_MAX_BYTES / 1024 / 1024) + ' MB of audio).',
      };
    }
    return { ok: true, audio: { path: output, sizeBytes: info.size, release } };
  } catch (e) {
    await release();
    return { ok: false, reason: 'failed', message: 'The video could not be pulled down in full (' + redact(e instanceof Error ? e.message : 'error') + ').' };
  }
}

/**
 * An extension ffmpeg can demux the source from.
 *
 * ffmpeg mostly probes the container rather than trusting the name, but a
 * .mov muxed differently from a .mp4 is read more reliably when the name says
 * so — and the sheet holds both.
 */
export function sourceExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return /^(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|mp3|m4a|wav|aac|ogg|flac)$/.test(ext) ? '.' + ext : '.mp4';
}

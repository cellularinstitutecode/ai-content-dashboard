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

export type BinaryResult =
  | { ok: true; path: string }
  /** Why it cannot be run — the three causes look identical from the outside. */
  | { ok: false; reason: 'no_path' | 'absent' | 'copy_failed'; detail: string };

export async function resolveFfmpeg(): Promise<BinaryResult> {
  if (resolvedBinary) return { ok: true, path: resolvedBinary };
  // FFMPEG_PATH is the escape hatch for a deployment where the packaged binary
  // never arrived — ffmpeg-static fetches it in an install script, and a build
  // that skips scripts leaves the package exporting a path to nothing.
  const src = process.env.FFMPEG_PATH || ffmpegStatic;
  if (!src) return { ok: false, reason: 'no_path', detail: 'ffmpeg-static resolved to no path.' };

  try {
    await access(src, FS.X_OK);
    resolvedBinary = src;
    return { ok: true, path: src };
  } catch { /* either absent, or present without the execute bit */ }

  const dest = path.join(tmpdir(), 'ffmpeg-static-bin');
  try {
    // A previous invocation on this same warm instance already did the copy.
    await access(dest, FS.X_OK);
    resolvedBinary = dest;
    return { ok: true, path: dest };
  } catch { /* first time on this instance */ }

  // Is the source there at all? "Present but not executable" is a bundling
  // problem this can fix; "not there" is a BUILD problem it cannot, and
  // reporting them the same way sent us hunting for the wrong one.
  try {
    await access(src, FS.F_OK);
  } catch {
    return { ok: false, reason: 'absent', detail: 'No file at ' + src + '. The build never fetched it — see scripts/ensure-ffmpeg.mjs.' };
  }

  try {
    await copyFile(src, dest);
    await chmod(dest, 0o755);
    resolvedBinary = dest;
    return { ok: true, path: dest };
  } catch (e) {
    reportError('audio-extract:binary', e, { src, dest });
    return { ok: false, reason: 'copy_failed', detail: 'Could not make a runnable copy at ' + dest + '.' };
  }
}

/** The path, or null. Kept for callers that only need "can it run". */
export async function ffmpegBinary(): Promise<string | null> {
  const r = await resolveFfmpeg();
  return r.ok ? r.path : null;
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
/**
 * Reading the source over HTTP instead of from disk.
 *
 * The flags that matter, none of them optional:
 *
 *  -headers            the Bearer token. Drive will not serve alt=media without
 *                      it, and ffmpeg has no other way to carry one. Must end
 *                      in CRLF or ffmpeg appends the next header to this line.
 *  -seekable 1         the whole point. An MP4 exported without faststart keeps
 *                      its moov index at the END, and ffmpeg has to range-
 *                      request backwards to find it. Without this the same file
 *                      that works from disk fails from a URL, which would have
 *                      made this path work only for the files that needed it
 *                      least.
 *  -multiple_requests  keep the connection alive between those range requests
 *                      instead of a fresh TLS handshake for each one.
 *  -protocol_whitelist alt=media answers with a redirect to a storage host, so
 *                      the chain has to be permitted explicitly.
 *  -reconnect*         a two-minute read of a gigabyte-plus file over a link
 *                      that hiccups once should not start again from nothing.
 *
 * There is deliberately no -follow_redirects here: it is not an option in the
 * build ffmpeg-static ships (redirects are followed by default), and passing it
 * makes ffmpeg exit before it opens anything — "Unrecognized option". The
 * integration test in test/audio-extract.test.mjs serves a redirect for exactly
 * this reason, because the failure is invisible until something real is on the
 * other end of the socket.
 *
 * The token appears in argv, which is visible to anything that can read the
 * process table on this machine. That is the cost of ffmpeg having no other way
 * to pass a header, and it is bounded: the token is a 50-minute service-account
 * credential, the machine is a single-tenant serverless sandbox, and stripToken
 * below keeps it out of every message that leaves this function.
 */
export const FFMPEG_URL_ARGS = (url: string, token: string, output: string): string[] => [
  '-nostdin',
  '-loglevel', 'error',
  '-y',
  '-headers', 'Authorization: Bearer ' + token + '\r\n',
  '-seekable', '1',
  '-multiple_requests', '1',
  '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
  '-reconnect', '1',
  '-reconnect_on_network_error', '1',
  '-reconnect_delay_max', '10',
  '-i', url,
  '-vn',
  '-ac', '1',
  '-ar', '16000',
  '-c:a', 'libmp3lame',
  '-b:a', '64k',
  output,
];

/**
 * Remove the credential from anything on its way to a log or a screen.
 *
 * lib/report.ts's redact() matches known secret shapes; a Google access token
 * is not one of them, and ffmpeg echoes its input URL — and sometimes its
 * headers — into stderr on failure. This is the belt to that braces: the exact
 * token we just passed, struck out by value, before redact() runs.
 */
export function stripToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('[token]');
}

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
 * Pull the audio out of a video WITHOUT ever staging the video.
 *
 * ffmpeg opens the Drive URL itself and range-requests its way through the
 * container, writing only the mp3. Nothing but the audio touches the scratch
 * disk, so the size ceiling that produced "that video is 1722 MB, past the
 * 450 MB the dashboard can pull down in one go" simply does not apply here.
 *
 * Used only above DISK_SAFE_BYTES (see lib/media-route.ts). Everything the
 * clinic normally posts keeps the older, proven path below — a new route that
 * runs only where the old one refused outright cannot regress anything.
 *
 * @param url    the Drive alt=media URL
 * @param token  the Bearer credential for it; never appears in any return value
 */
export async function extractAudioFromUrl(
  url: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const resolved = await resolveFfmpeg();
  if (!resolved.ok) {
    return { ok: false, reason: 'not_available', message: 'The audio extractor is not runnable on this deployment: ' + resolved.detail };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'chi-audio-'));
  const release = async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); };
  const output = path.join(dir, 'audio.mp3');

  try {
    await run(resolved.path, FFMPEG_URL_ARGS(url, token, output), {
      // Longer than the disk path's 20s: this one is doing the transfer as
      // well as the decode, and it is only ever reached by files big enough
      // that the transfer is the slow part.
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: string; code?: string | number; killed?: boolean; message?: string };
    const stderr = stripToken(String(err?.stderr || ''), token);
    if (/does not contain any stream|Output file (#0 )?does not contain/i.test(stderr)) {
      await release();
      return { ok: false, reason: 'no_audio', message: 'That video has no sound to transcribe.' };
    }
    await release();
    const why = stderr.trim()
      ? redact(stderr.slice(0, 200))
      : err?.killed
        ? 'reading it from Drive took too long and was stopped'
        : 'the extractor could not be started (' + String(err?.code || err?.message || 'unknown') + ')';
    reportError('audio-extract:ffmpeg-url', new Error(stripToken(String(err?.message || 'ffmpeg url failed'), token)), { binary: resolved.path });
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
  const resolved = await resolveFfmpeg();
  if (!resolved.ok) {
    return { ok: false, reason: 'not_available', message: 'The audio extractor is not runnable on this deployment: ' + resolved.detail };
  }
  const ffmpeg = resolved.path;
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

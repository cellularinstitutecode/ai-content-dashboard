// web/lib/image-downscale.ts
// Make an imported picture the size it will actually be shown at.
//
// The rule (lib/image-fit.ts) is pure and tested; this is the ffmpeg run that
// acts on it, using the binary the transcription pipeline already ships
// (lib/audio-extract.ts resolves it to somewhere runnable). Fail-soft in every
// direction: when ffmpeg is missing, refuses, or produces nothing, the caller
// gets the original bytes back and stores them exactly as before this existed.
// Losing a few megabytes of storage is the old behaviour; losing the import
// would be a regression.
import 'server-only';

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveFfmpeg } from '@/lib/audio-extract';
import { FFMPEG_FIT_ARGS, fitDecision } from './image-fit.ts';
import { reportError } from '@/lib/report';

const run = promisify(execFile);

export type FittedImage = {
  bytes: Buffer;
  contentType: string;
  ext: string;
  /** True when the bytes are a re-encoded copy rather than the original. */
  resized: boolean;
};

/**
 * The bytes to store for an imported image, and what to call them.
 *
 * @param bytes        the file as it came from Drive
 * @param contentType  its declared type
 * @param ext          the extension the caller would have used for the original
 */
export async function fitImage(bytes: Buffer, contentType: string, ext: string): Promise<FittedImage> {
  const original: FittedImage = { bytes, contentType, ext, resized: false };
  const decision = fitDecision(contentType, bytes.length);
  if (decision.action === 'keep') return original;

  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg.ok) {
    reportError('image-downscale:binary', new Error(ffmpeg.detail), { reason: ffmpeg.reason });
    return original;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'chi-image-'));
  const input = path.join(dir, 'in.' + (ext || 'bin'));
  const output = path.join(dir, 'out.' + decision.ext);
  try {
    await writeFile(input, bytes);
    await run(ffmpeg.path, FFMPEG_FIT_ARGS(input, output, decision.codec), { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const out = await readFile(output);
    // A result that is not smaller is not worth the re-encode; keep the original.
    if (!out.length || out.length >= bytes.length) return original;
    return { bytes: out, contentType: decision.contentType, ext: decision.ext, resized: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    reportError('image-downscale:ffmpeg', new Error(String(err?.stderr || err?.message || 'ffmpeg failed').slice(0, 200)), { contentType });
    return original;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

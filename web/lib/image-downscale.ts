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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveFfmpeg } from '@/lib/audio-extract';
import { FFMPEG_FIT_ARGS, fitDecision } from './image-fit.ts';
import { reportError } from '@/lib/report';

const run = promisify(execFile);

/** An original larger than this is not stored as-is (import_image refuses it). */
export const FIT_ORIGINAL_MAX_BYTES = 25 * 1024 * 1024;

export type FittedImage = {
  /** Null when the original could not be shrunk and is too big to store. */
  bytes: Buffer | null;
  contentType: string;
  ext: string;
  /** True when the bytes are a re-encoded copy rather than the original. */
  resized: boolean;
};

/**
 * The bytes to store for an imported image, and what to call them.
 *
 * The picture is read from disk (downloadDriveFileToDisk put it there) and
 * only the result is loaded into memory, so a 200 MB export never is. When
 * ffmpeg cannot shrink it, the original comes back as it was, or, above
 * FIT_ORIGINAL_MAX_BYTES, `bytes: null`: too big to store, and not read.
 *
 * @param input        the file as it came from Drive
 * @param size         its size in bytes
 * @param contentType  its declared type
 * @param ext          the extension the caller would have used for the original
 */
export async function fitImage(input: string, size: number, contentType: string, ext: string): Promise<FittedImage> {
  const original = async (): Promise<FittedImage> => ({ bytes: await readFile(input), contentType, ext, resized: false });
  // An original too big to store is not read into memory just to be refused.
  const refused = (): FittedImage => ({ bytes: null, contentType, ext, resized: false });
  const fallback = () => (size > FIT_ORIGINAL_MAX_BYTES ? refused() : original());
  const decision = fitDecision(contentType, size);
  if (decision.action === 'keep') return fallback();

  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg.ok) {
    reportError('image-downscale:binary', new Error(ffmpeg.detail), { reason: ffmpeg.reason });
    return fallback();
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'chi-image-'));
  const output = path.join(dir, 'out.' + decision.ext);
  try {
    // Two minutes: a 200 MB PNG decodes slowly, and the download before it is
    // capped so the two together fit the route's five.
    await run(ffmpeg.path, FFMPEG_FIT_ARGS(input, output, decision.codec), { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const out = await readFile(output);
    // A result that is not smaller is not worth the re-encode; keep the original.
    if (!out.length || out.length >= size) return await fallback();
    return { bytes: out, contentType: decision.contentType, ext: decision.ext, resized: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    reportError('image-downscale:ffmpeg', new Error(String(err?.stderr || err?.message || 'ffmpeg failed').slice(0, 200)), { contentType });
    return fallback();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

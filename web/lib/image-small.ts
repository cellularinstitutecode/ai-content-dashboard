// web/lib/image-small.ts
// A small JPEG of a picture, for the passes that only need to LOOK at it.
//
// A third of the clinic's folder is 30 MB camera exports saved as PNG. Handing
// those to the vision model or decoding them whole to average their colour is
// what left 70 of 175 photographs unread: 21 refused as too large to send, and
// 49 that timed out mid-decode. Neither pass needs the pixels — one asks what
// the picture shows, the other asks what colour it is on average, and both
// answers survive a 768px JPEG intact.
//
// Same ffmpeg the rest of the image work uses, so nothing new is installed.
import 'server-only';

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveFfmpeg } from '@/lib/audio-extract';

const run = promisify(execFile);

/**
 * Scale a picture down to `width` and re-encode as JPEG.
 *
 * Returns null when ffmpeg is unavailable or refuses the file — every caller
 * falls back to the original bytes, which is exactly the behaviour they had
 * before this existed.
 */
export async function smallJpeg(bytes: Buffer, ext = 'png', width = 768): Promise<Buffer | null> {
  const bin = await resolveFfmpeg();
  if (!bin.ok) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'small-'));
  const src = path.join(dir, `in.${ext}`);
  const out = path.join(dir, 'out.jpg');
  try {
    await writeFile(src, bytes);
    await run(
      bin.path,
      ['-v', 'error', '-y', '-i', src, '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', out],
      // A 34 MB PNG genuinely takes a while to decode; the old twenty seconds
      // was the reason the best photographs in the folder were never read.
      { timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    const buf = await readFile(out);
    return buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

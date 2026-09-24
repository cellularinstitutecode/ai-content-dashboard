// web/lib/palette-measure.ts
// Decode a picture small and measure it (lib/palette.ts does the arithmetic).
//
// ffmpeg is already the image tool here — lib/image-downscale.ts resizes every
// imported photo with it — so measuring costs no new dependency. The picture is
// scaled to 64px wide before the pixels are counted: the mean of a photograph
// does not change with resolution, and a 25 MB original would otherwise be
// decoded in full to learn its average colour.
import 'server-only';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveFfmpeg } from '@/lib/audio-extract';
import { statsFromRgb, type PaletteStats } from './palette.ts';

const run = promisify(execFile);

/** Measure one picture. Null when ffmpeg is unavailable or refuses the file. */
export async function measureImage(bytes: Buffer, ext = 'png'): Promise<PaletteStats | null> {
  const bin = await resolveFfmpeg();
  if (!bin.ok) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'palette-'));
  const src = path.join(dir, `in.${ext}`);
  try {
    await writeFile(src, bytes);
    const { stdout } = await run(
      bin.path,
      ['-v', 'error', '-i', src, '-vf', 'scale=64:-1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      // 90 seconds, not 20: a 34 MB PNG decodes slowly, and the short timeout
      // was why a third of the folder came back unreadable.
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 90_000 },
    );
    const buf = stdout as unknown as Buffer;
    return buf?.length ? statsFromRgb(new Uint8Array(buf)) : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

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
import { promisify } from 'node:util';

import { resolveFfmpeg } from '@/lib/audio-extract';
import { statsFromRgb, type PaletteStats } from './palette.ts';
import { bandDetail, type BandDetail } from './cover-bands.ts';

const run = promisify(execFile);

/** Measure one picture on disk. Null when ffmpeg is unavailable or refuses the file. */
export async function measureImage(src: string): Promise<PaletteStats | null> {
  const bin = await resolveFfmpeg();
  if (!bin.ok) return null;
  try {
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
  }
}

/**
 * How much detail the top and bottom bands of a picture carry
 * (lib/cover-bands.ts), from a file on disk or the bytes in hand. Decoded
 * 96px wide: a gradient and a skin count at that size tell a wall from a
 * crowd, and a face from a table, as well as the full picture would. Null
 * when ffmpeg is unavailable.
 */
export async function measureBands(src: string | Buffer): Promise<BandDetail | null> {
  const bin = await resolveFfmpeg();
  if (!bin.ok) return null;
  const W = 96;
  try {
    const input = typeof src === 'string' ? src : 'pipe:0';
    const child = execFile(
      bin.path,
      ['-v', 'error', '-i', input, '-vf', `scale=${W}:-1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 90_000 },
    );
    if (typeof src !== 'string' && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(src); }
    const buf: Buffer = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg exited ' + code))));
    });
    if (!buf.length || buf.length % (W * 3)) return null;
    const height = buf.length / (W * 3);
    return bandDetail(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), W, height);
  } catch {
    return null;
  }
}

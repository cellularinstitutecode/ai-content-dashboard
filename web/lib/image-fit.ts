// web/lib/image-fit.ts
// Whether an imported picture should be stored as it came, or made smaller.
//
// import_image (app/api/sources) copies a Drive photo into the public bucket
// so Metricool can fetch it. It stored the ORIGINAL — a phone photo of 8 MB, a
// camera export of 25 MB — when every network it will ever be posted to
// re-encodes it to a couple of megapixels on arrival. The bucket paid for the
// difference on every import, permanently.
//
// The decision lives here, import-free, so it can be tested; the ffmpeg run
// that acts on it is in lib/image-downscale.ts.

/** Above this an import is re-encoded. Below it the original is kept as-is. */
export const DOWNSCALE_ABOVE_BYTES = 1024 * 1024;

/** The longest edge after re-encoding. Every social network downsizes past this anyway. */
export const MAX_EDGE_PX = 2048;

export type FitDecision =
  | { action: 'keep'; why: 'small' | 'gif' | 'unknown_type' }
  /** Re-encode with ffmpeg; `ext`/`contentType` describe the stored result. */
  | { action: 'reencode'; codec: 'jpeg' | 'png'; ext: 'jpg' | 'png'; contentType: 'image/jpeg' | 'image/png' };

/**
 * What to do with `bytes` of `contentType`.
 *
 *  - GIFs are kept: re-encoding one keeps the first frame and loses the motion.
 *  - Small files are kept: nothing to gain, and a small PNG is often a graphic
 *    whose transparency a JPEG would paint black.
 *  - Large PNGs stay PNG (transparency survives) but are downscaled.
 *  - Everything else large becomes a JPEG at a quality no network can tell apart.
 */
export function fitDecision(contentType: string, bytes: number): FitDecision {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!/^image\//.test(type)) return { action: 'keep', why: 'unknown_type' };
  if (type === 'image/gif') return { action: 'keep', why: 'gif' };
  if (!(bytes > DOWNSCALE_ABOVE_BYTES)) return { action: 'keep', why: 'small' };
  if (type === 'image/png') return { action: 'reencode', codec: 'png', ext: 'png', contentType: 'image/png' };
  return { action: 'reencode', codec: 'jpeg', ext: 'jpg', contentType: 'image/jpeg' };
}

/**
 * The ffmpeg invocation for one decision.
 *
 * The scale filter fits the picture inside MAX_EDGE × MAX_EDGE without ever
 * enlarging it (`min(iw, N)` on each axis, aspect kept by `decrease`).
 * `-frames:v 1` guards against an animated source producing a sequence.
 */
export function FFMPEG_FIT_ARGS(input: string, output: string, codec: 'jpeg' | 'png'): string[] {
  const box = 'scale=w=\'min(iw,' + MAX_EDGE_PX + ')\':h=\'min(ih,' + MAX_EDGE_PX + ')\':force_original_aspect_ratio=decrease:flags=lanczos';
  const encoder = codec === 'png'
    ? ['-c:v', 'png']
    // q:v 3 is roughly JPEG quality 90; yuvj420p is the pixel format every
    // JPEG reader expects and the one an RGBA source has to be converted to.
    : ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p'];
  return [
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-i', input,
    '-frames:v', '1',
    '-vf', box,
    ...encoder,
    output,
  ];
}

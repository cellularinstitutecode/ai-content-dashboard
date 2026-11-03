// web/lib/cover-bands.ts
// Which band of a photograph is quiet enough to carry the title, and which
// side of that band.
//
// The vision check reports where the highest head starts, and it has been
// wrong by a factor of two ("50" for a head a fifth of the way down). The
// feed's titles sit on plain areas — a ceiling, a wall, a table top, a
// floor — and never on a face, so the picture itself is asked two things
// about its top band and its bottom band, from one small decode
// (lib/palette-measure.ts measureBands):
//
//   skin    how much of the band is skin-coloured (YCbCr, the usual range):
//           a band with a face or bare arms in it is the one to avoid, before
//           anything else is weighed;
//   detail  the mean gradient of the greyscale picture: a wall reads low, a
//           crowd or a table of food high.
//
// A band with clearly more skin than the other loses; otherwise the band with
// much less detail wins; two alike decide nothing, and the head decides. The
// same two measures, taken on each half of the chosen band, say whether the
// block should sit left or right of a person standing on one side.
//
// The cover shows the top 83.3% of a 2:3 photograph (cropped to 4:5 from
// the top), so the bands are taken on that part.

/** The fraction of the photograph's height the cover shows. */
export const SHOWN = 0.833;
/** The top band: the cover's first ~third. */
export const TOP_BAND: [number, number] = [0, 0.3 * SHOWN];
/** The bottom band: the cover's last ~third. */
export const BOTTOM_BAND: [number, number] = [0.66 * SHOWN, SHOWN];
/** One band must carry less than this share of the other's detail to count as the quiet one. */
export const QUIET_RATIO = 0.6;
/** Skin on at least this share of a band means a person is in it. */
export const SKIN_MIN = 0.02;
/** A band with this many times the other's skin is the one with the person. */
export const SKIN_RATIO = 2;

export type Measure = { detail: number; skin: number };
export type BandMeasure = Measure & { left: Measure; right: Measure };
export type BandDetail = { top: BandMeasure; bottom: BandMeasure };

function isSkin(r: number, g: number, b: number): boolean {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/** The two measures over a box of an RGB picture (three bytes per pixel, row-major). */
function measure(rgb: Uint8Array, width: number, height: number, y0f: number, y1f: number, x0f: number, x1f: number): Measure {
  const y0 = Math.max(1, Math.floor(y0f * height));
  const y1 = Math.min(height - 1, Math.ceil(y1f * height));
  const x0 = Math.max(1, Math.floor(x0f * width));
  const x1 = Math.min(width - 1, Math.ceil(x1f * width));
  const gray = (i: number) => (rgb[i * 3] * 299 + rgb[i * 3 + 1] * 587 + rgb[i * 3 + 2] * 114) / 1000;
  let sum = 0;
  let skin = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      sum += Math.abs(gray(i + 1) - gray(i - 1)) + Math.abs(gray(i + width) - gray(i - width));
      if (isSkin(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])) skin++;
      n++;
    }
  }
  return n ? { detail: sum / n, skin: skin / n } : { detail: 0, skin: 0 };
}

/** The measures of each band, and of each half of each band. */
export function bandDetail(rgb: Uint8Array, width: number, height: number): BandDetail {
  const band = (from: number, to: number): BandMeasure => ({
    ...measure(rgb, width, height, from, to, 0, 1),
    left: measure(rgb, width, height, from, to, 0, 0.5),
    right: measure(rgb, width, height, from, to, 0.5, 1),
  });
  return { top: band(TOP_BAND[0], TOP_BAND[1]), bottom: band(BOTTOM_BAND[0], BOTTOM_BAND[1]) };
}

/** Of two measures, the quiet one: 'a' or 'b' when one clearly is, else null. */
function quieter(a: Measure, b: Measure): 'a' | 'b' | null {
  // A person first: the measure with clearly more skin is the one to avoid.
  if (a.skin >= SKIN_MIN && a.skin >= b.skin * SKIN_RATIO) return 'b';
  if (b.skin >= SKIN_MIN && b.skin >= a.skin * SKIN_RATIO) return 'a';
  if (a.detail < b.detail * QUIET_RATIO) return 'a';
  if (b.detail < a.detail * QUIET_RATIO) return 'b';
  return null;
}

/** The quiet band, when one clearly is; null when neither is. */
export function quietBand(d: BandDetail | null | undefined): 'top' | 'bottom' | null {
  if (!d) return null;
  const q = quieter(d.top, d.bottom);
  return q === 'a' ? 'top' : q === 'b' ? 'bottom' : null;
}

/** Within a band, the quiet half, when one clearly is: where a person stands on one side, the block goes to the other. */
export function quietSide(d: BandDetail | null | undefined, band: 'top' | 'bottom'): 'left' | 'right' | null {
  if (!d) return null;
  const m = d[band];
  const q = quieter(m.left, m.right);
  return q === 'a' ? 'left' : q === 'b' ? 'right' : null;
}

/** The side within the band the title will take, given what placeTitle will decide from these hints (lib/title-cover-layout.ts). */
export function quietSideFor(d: BandDetail | null | undefined, hints: { headTopPct?: number | null; quiet?: 'top' | 'bottom' | null }): 'left' | 'right' | null {
  if (!d) return null;
  const head = typeof hints.headTopPct === 'number' && Number.isFinite(hints.headTopPct) ? hints.headTopPct : null;
  const top = (head != null && head >= 55) || (head != null && head >= 30 && hints.quiet === 'top');
  return quietSide(d, top ? 'top' : 'bottom');
}

/** Both hints at once, for a caller that spreads them into the renderer's input. */
export function quietHints(d: BandDetail | null | undefined, headTopPct: number | null | undefined): { quiet: 'top' | 'bottom' | null; quietSide: 'left' | 'right' | null } {
  const quiet = quietBand(d);
  return { quiet, quietSide: quietSideFor(d, { headTopPct, quiet }) };
}

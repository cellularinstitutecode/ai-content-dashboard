// web/lib/palette.ts
//
// THE BRAND'S MEASURED PALETTE, and what it takes to bring a real photograph
// into it.
//
// The clinic has 165 real photographs in its Drive folder and a feed of
// AI-generated covers that look nothing like them. The covers were measured —
// fourteen of them, photo area only, title band excluded — and they sit in a
// narrow box: light, warm-neutral, notably desaturated. The gallery is close to
// the opposite: fluorescent and blue-grey, darker, higher contrast from phone
// cameras, and in a few cases lit magenta by an LED therapy bed.
//
// A single "filter" cannot serve both, which is why this is a measurement and a
// per-image correction rather than a preset. Each photograph is measured, moved
// toward the target by whatever it needs, and — crucially — REFUSED when what it
// needs exceeds what a grade can honestly do. A photograph pushed that far stops
// looking like a photograph.
//
// Pure on purpose: the arithmetic here decides what every imported picture looks
// like, so it is unit-tested rather than eyeballed. lib/palette-measure.ts does
// the ffmpeg decode that feeds it.

/** What one picture measures. Channel means are 0-255; sat and lum are 0-100 and 0-255. */
export type PaletteStats = {
  r: number;
  g: number;
  b: number;
  /** R-B. Positive is warm, negative is a cool or fluorescent cast. */
  warm: number;
  /** Mean saturation as a percentage. */
  sat: number;
  /** Mean luminance, 0-255 (Rec. 709). */
  lum: number;
};

/**
 * The target, measured from 14 published covers on 24 September 2026.
 * Re-measure and update this if the house style moves.
 */
export const BRAND_TARGET: PaletteStats = { r: 171, g: 158, b: 136, warm: 35, sat: 24.5, lum: 159 };

/**
 * How far each measure may be moved. Past these the correction stops being a
 * grade and starts being a lie about what the room looked like.
 */
export const GRADE_LIMITS = {
  /**
   * Warm delta shift, in 0-255 channel units. Wide enough that ordinary
   * fluorescent clinic light — which sits around -10 while the target is +35 —
   * is a routine correction rather than a refusal.
   */
  warm: 70,
  /** Saturation shift, in percentage points. */
  sat: 22,
  /** Luminance lift or cut, 0-255. */
  lum: 60,
} as const;

export type Verdict = 'ready' | 'grade' | 'outside';

export type Grade = {
  verdict: Verdict;
  /** Why, in words a person can act on. */
  reason: string;
  /** How far this picture is from the target, 0 = on it. */
  distance: number;
  /** The ffmpeg filter chain that moves it, empty when nothing is needed or it is refused. */
  filters: string[];
};

/** Mean stats from a raw rgb24 buffer (as ffmpeg -f rawvideo -pix_fmt rgb24 emits). */
export function statsFromRgb(buf: Uint8Array): PaletteStats {
  const n = Math.floor(buf.length / 3);
  if (!n) return { r: 0, g: 0, b: 0, warm: 0, sat: 0, lum: 0 };
  let r = 0, g = 0, b = 0, sat = 0, lum = 0;
  for (let i = 0; i < n * 3; i += 3) {
    const R = buf[i], G = buf[i + 1], B = buf[i + 2];
    r += R; g += G; b += B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    sat += mx ? (mx - mn) / mx : 0;
    lum += 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    r: round(r / n), g: round(g / n), b: round(b / n),
    warm: round((r - b) / n), sat: round((sat / n) * 100), lum: round(lum / n),
  };
}

/**
 * Distance from the target, normalised so the three measures carry comparable
 * weight: a 45-unit cast, a 22-point saturation gap and a 60-unit exposure gap
 * each count as 1.
 */
export function paletteDistance(s: PaletteStats, target: PaletteStats = BRAND_TARGET): number {
  const w = Math.abs(s.warm - target.warm) / GRADE_LIMITS.warm;
  const t = Math.abs(s.sat - target.sat) / GRADE_LIMITS.sat;
  const l = Math.abs(s.lum - target.lum) / GRADE_LIMITS.lum;
  return Math.round(Math.sqrt(w * w + t * t + l * l) * 100) / 100;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * What to do with one photograph.
 *
 * 'ready'   already inside the palette; leave it alone.
 * 'grade'   a correction within the limits brings it in.
 * 'outside' it needs more than a grade can honestly give — the magenta LED
 *           room and the near-black corridor land here, and should be shot
 *           again rather than pushed.
 */
export function gradeFor(s: PaletteStats, target: PaletteStats = BRAND_TARGET): Grade {
  const distance = paletteDistance(s, target);
  const dWarm = target.warm - s.warm;
  const dSat = target.sat - s.sat;
  const dLum = target.lum - s.lum;

  if (Math.abs(dWarm) > GRADE_LIMITS.warm || Math.abs(dSat) > GRADE_LIMITS.sat || Math.abs(dLum) > GRADE_LIMITS.lum) {
    const why = Math.abs(dWarm) > GRADE_LIMITS.warm
      ? (dWarm > 0 ? 'too cold to correct without it looking tinted' : 'too warm to correct without it looking tinted')
      : Math.abs(dSat) > GRADE_LIMITS.sat
        ? (dSat < 0 ? 'far too saturated — coloured light in the room' : 'almost no colour left to work with')
        : (dLum > 0 ? 'too dark to lift cleanly' : 'too bright — detail is already gone');
    return { verdict: 'outside', reason: why, distance, filters: [] };
  }

  if (distance <= 0.35) return { verdict: 'ready', reason: 'already in the palette', distance, filters: [] };

  // Warm delta moves through the red and blue gains; a third of the delta in
  // each direction lands the R-B difference where it belongs without tinting
  // the midtones.
  // Three quarters of the way, not all of it. A photograph that has been moved
  // exactly onto a target reads as tinted; leaving it a little of its own light
  // is what keeps it looking like a room someone stood in.
  const REACH = 0.75;
  const rGain = clamp((dWarm * REACH) / 255 / 2, -0.3, 0.3);
  const bGain = clamp((-dWarm * REACH) / 255 / 2, -0.3, 0.3);
  // eq takes saturation as a multiplier and brightness as a -1..1 offset.
  const satMul = clamp(s.sat > 1 ? 1 + ((target.sat / s.sat) - 1) * REACH : 1, 0.5, 1.6);
  const bright = clamp((dLum * REACH) / 255, -0.3, 0.3);
  // Phone cameras carry more contrast than the covers do; easing it is what
  // makes a real photograph sit beside a generated one.
  const contrast = 0.94;

  const f = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
  return {
    verdict: 'grade',
    reason: 'corrected toward the house palette',
    distance,
    filters: [
      `colorbalance=rm=${f(rGain)}:gm=0:bm=${f(bGain)}`,
      `eq=contrast=${f(contrast)}:brightness=${f(bright)}:saturation=${f(satMul)}`,
    ],
  };
}

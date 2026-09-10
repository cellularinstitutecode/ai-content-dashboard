// web/lib/mobius-progress.ts
// The arithmetic behind the loading indicator, kept where it can be tested.
//
// components/MobiusProgress.tsx is a React component and this repo's test
// runner only reaches lib/ — so the two things that can actually be WRONG (the
// dash arithmetic and the clamping) live here, and the component is left as
// markup around them.
//
// Why a Möbius strip is the right shape rather than a decorative one: it has
// exactly ONE edge. A single continuous stroke really does traverse the whole
// band, so "the accent fills as it goes" is a true statement about the figure
// instead of a metaphor laid over a circle.
//
// No imports: the test runner strips types and runs this file directly.

/**
 * The path declares its own length as 100 via SVG's `pathLength` attribute, so
 * a percentage IS the dash offset and nothing has to be measured.
 *
 * The alternative — getTotalLength() — needs a ref, a mounted node and a layout
 * read, and returns a different number for every size the component is drawn
 * at. lib/... the existing Ring in LoadingScreen.tsx computes 2πr by hand for
 * exactly one reason: a circle's length is knowable. A lemniscate's is not.
 */
export const PATH_LENGTH = 100;

/**
 * 0-100, with anything absurd brought back inside it.
 *
 * NaN and Infinity are not the same mistake and must not get the same answer.
 * NaN is an absence of information, so it shows nothing; Infinity is a number
 * past the end of the scale, so it shows a full band. Guarding both with
 * `!Number.isFinite` — which was the first version — reported a completed job
 * as not started.
 */
export function clampPercent(percent: number): number {
  if (Number.isNaN(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * How much of the band is still empty.
 *
 * strokeDasharray is the whole length and strokeDashoffset is what remains, so
 * 0% offsets by the entire path (nothing drawn) and 100% offsets by none of it.
 */
export function dashOffsetFor(percent: number): number {
  return PATH_LENGTH - clampPercent(percent);
}

/**
 * A lemniscate — the flat projection of a Möbius band — in a 100x100 box.
 *
 * Drawn from the centre out to the right lobe, back through the centre, out to
 * the left lobe and home, so the stroke starts filling at the crossing and
 * travels the whole figure once. Both lobes are the same size on purpose: an
 * asymmetric one reads as a bug rather than as perspective.
 */
export const MOBIUS_PATH =
  'M50 50 C 58 32, 84 32, 84 50 C 84 68, 58 68, 50 50 C 42 32, 16 32, 16 50 C 16 68, 42 68, 50 50 Z';

/** The inner edge of the ribbon, which is what makes it read as a band and not a wire. */
export const MOBIUS_INNER_PATH =
  'M50 50 C 56 39, 76 39, 76 50 C 76 61, 56 61, 50 50 C 44 39, 24 39, 24 50 C 24 61, 44 61, 50 50 Z';

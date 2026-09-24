// web/lib/library-match.ts
//
// PICKING A REAL PHOTOGRAPH FOR A POST, when one exists.
//
// The captioning pass (lib/library-caption.ts) read 105 of the folder's 175
// photographs and found 28 that the cover rules allow. Split by pillar, the
// answer was lopsided: Protocols 22, Diagnosis 16, Follow-up 16, Recovery 12 —
// and Nutrition 1, Movement 1, Sleep 3. The clinical half of the feed can lead
// with the clinic's own rooms; the lifestyle half cannot, and no ranking
// function invents a photograph of food that nobody took.
//
// So this deliberately returns NOTHING rather than a near-miss. A post about
// sleep offered a picture of a waiting room is worse than a generated picture
// of sleep: it looks like the clinic could not be bothered. The generator is a
// good fallback, and a matcher that knows when to decline is what makes using
// it honest.

import { coverSafe, pillarsFor, type Caption } from './library-caption.ts';
import { gradeFor, type PaletteStats } from './palette.ts';

/** A photograph the folder holds, as the two passes describe it. */
export type Candidate = {
  id: string;
  name: string;
  caption: Caption;
  /** From lib/palette-measure.ts. Absent when the picture was never measured. */
  stats?: PaletteStats | null;
  /** Set when the clinic has confirmed a release for the people in it. */
  consentCleared?: boolean;
};

export type Match = {
  id: string;
  name: string;
  why: string;
  score: number;
  /** The grade to apply before it is used, empty when it needs none. */
  filters: string[];
};

/**
 * How good the colour fit has to be before a real photograph beats generating
 * one. A picture needing a correction near the limit scores close to zero here
 * and is passed over: it would technically grade, but only just, and a cover
 * that has been dragged that far is not worth using over a generated one.
 */
const MIN_SCORE = 0.35;

/**
 * The best real photograph for a pillar, or null when the folder has nothing
 * honest to offer.
 *
 * Rejections, in order, and each one silent by design — the caller simply
 * generates instead:
 *   the cover rules refuse it (text, a procedure, a device on someone)
 *   it shows an identifiable patient and no release is recorded
 *   its subject does not serve this pillar
 *   its colour is too far from the house palette to grade
 */
export function pickForPillar(candidates: readonly Candidate[], pillarId: string): Match | null {
  let best: Match | null = null;
  for (const c of candidates) {
    const safe = coverSafe(c.caption);
    if (!safe.ok) continue;
    if (safe.needsConsent && !c.consentCleared) continue;

    const pillars = pillarsFor(c.caption);
    if (!pillars.includes(pillarId)) continue;

    // An unmeasured picture is not assumed to be fine — it is passed over, so
    // the first time a real photograph ships it has been through both passes.
    if (!c.stats) continue;
    const g = gradeFor(c.stats);
    if (g.verdict === 'outside') continue;

    // Colour fit carries the decision: one already in the palette beats one
    // needing correction, and one needing a correction near the limit loses to
    // the generator.
    const fit = g.verdict === 'ready' ? 1 : Math.max(0, 1 - g.distance / 2);
    // Focus only breaks ties. A photograph that serves fewer pillars serves
    // this one more squarely — a picture tagged only "food" is a better
    // nutrition cover than one tagged consultation, portrait and team — but a
    // versatile picture should not be punished into unusability for it.
    const focus = 1 / pillars.length;
    const score = Math.round((fit + focus * 0.25) * 100) / 100;
    if (score < MIN_SCORE) continue;

    if (!best || score > best.score) {
      best = {
        id: c.id,
        name: c.name,
        score,
        filters: g.filters,
        why: `${c.caption.subjects.join(', ')} — ${g.verdict === 'ready' ? 'already in the palette' : 'graded into the palette'}`,
      };
    }
  }
  return best;
}

/**
 * How many pillars the folder can actually serve, and which cannot be served at
 * all. The second list is the one worth acting on: those posts need
 * photographs taken, not code.
 */
export function coverage(candidates: readonly Candidate[], pillars: readonly string[]): { served: Record<string, number>; empty: string[] } {
  const served: Record<string, number> = {};
  for (const p of pillars) served[p] = pickForPillar(candidates, p) ? 1 : 0;
  for (const c of candidates) {
    const safe = coverSafe(c.caption);
    if (!safe.ok || (safe.needsConsent && !c.consentCleared) || !c.stats) continue;
    if (gradeFor(c.stats).verdict === 'outside') continue;
    for (const p of pillarsFor(c.caption)) if (p in served) served[p] += 1;
  }
  for (const p of pillars) served[p] = Math.max(0, served[p] - (served[p] > 0 ? 1 : 0));
  return { served, empty: pillars.filter((p) => !served[p]) };
}

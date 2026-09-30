// web/lib/library-topic.ts
// WHICH PILLAR A POST IS ABOUT, from its words — and which library photograph
// to give it WITHOUT giving every post the same one.
//
// lib/library-match.ts picks a photograph for a planner pillar id. A post from
// a dropped strategy, or one the assistant wrote, has no pillar id: it has a
// topic and its copy. This reads those for the pillar vocabulary the library's
// captions are mapped to (lib/library-caption.ts SUBJECT_PILLARS), so "muscle
// strength and longevity" finds the movement photographs and "a thorough
// medical assessment" the consultation ones.
//
// Pure on purpose: the vocabulary and the no-repeat rule decide which real
// photograph a post gets, so they are tested rather than trusted.
import { coverSafe, pillarsFor, type Caption } from './library-caption.ts';
import { gradeFor, type PaletteStats } from './palette.ts';

/** A photograph is not offered again within this many days of its last use. */
export const REUSE_WINDOW_DAYS = 45;

/** Words that place a post under a pillar the captions know. Lower-case; matched as whole words. */
const PILLAR_WORDS: Record<string, string[]> = {
  movement: ['exercise', 'exercises', 'movement', 'strength', 'muscle', 'muscles', 'resistance', 'training', 'workout', 'walk', 'walking', 'mobility', 'fitness', 'active', 'stretching', 'yoga', 'cardio'],
  'active-living': ['outdoors', 'outdoor', 'beach', 'swim', 'swimming', 'hiking', 'cycling', 'bike'],
  nutrition: ['nutrition', 'food', 'foods', 'diet', 'dietary', 'meal', 'meals', 'eating', 'protein', 'vegetables', 'fiber', 'fibre', 'sugar', 'hydration'],
  'practical-nutrition': ['recipe', 'recipes', 'grocery', 'cooking', 'kitchen', 'breakfast', 'lunch', 'dinner'],
  supplementation: ['supplement', 'supplements', 'supplementation', 'vitamin', 'vitamins', 'minerals', 'omega', 'magnesium', 'nutrients'],
  sleep: ['sleep', 'sleeping', 'insomnia', 'circadian', 'bedtime', 'rest', 'restorative'],
  stress: ['stress', 'anxiety', 'cortisol', 'mindfulness', 'meditation', 'breathing', 'relaxation', 'burnout'],
  'sleep-stress': ['sleep', 'stress'],
  diagnosis: ['assessment', 'assessments', 'diagnosis', 'diagnostic', 'diagnostics', 'evaluation', 'evaluate', 'testing', 'tests', 'lab', 'labs', 'bloodwork', 'biomarkers', 'imaging', 'screening', 'history', 'symptoms', 'consultation'],
  'assessment-prevention': ['assessment', 'prevention', 'preventive', 'screening', 'early'],
  protocols: ['protocol', 'protocols', 'treatment', 'treatments', 'therapy', 'therapies', 'personalized', 'personalised', 'individualized', 'plan', 'regenerative', 'stem', 'exosome', 'exosomes', 'peptide', 'peptides', 'iv', 'infusion'],
  'follow-up': ['follow-up', 'followup', 'follow', 'progress', 'check-in', 'monitoring', 'adjust', 'adjustments', 'review', 'results'],
  recovery: ['recovery', 'recover', 'healing', 'restoration', 'restore', 'rehabilitation', 'inflammation', 'immune', 'longevity', 'aging', 'ageing', 'wellness'],
  'recovery-cancun': ['recovery lounge', 'resort', 'retreat'],
  cancun: ['cancun', 'cancún', 'mexico', 'travel', 'flight', 'flights', 'airport', 'tourism', 'visit', 'stay', 'hotel'],
  prevention: ['prevention', 'preventive', 'prevent', 'risk'],
};

/**
 * The pillars a post's words place it under, best first. Empty when nothing
 * in the text names one — the caller then generates, as before, rather than
 * illustrating a post about nothing in particular with a waiting room.
 */
export function pillarsForText(text: string): string[] {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9áéíóúñü\- ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const counts = new Map<string, number>();
  const seen = new Set(words);
  for (const [pillar, vocab] of Object.entries(PILLAR_WORDS)) {
    let n = 0;
    for (const w of vocab) {
      if (w.includes(' ')) { if (String(text || '').toLowerCase().includes(w)) n += 2; continue; }
      if (seen.has(w)) n += words.filter((x) => x === w).length;
    }
    if (n > 0) counts.set(pillar, n);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
}

/** A photograph the index holds, as lib/library-index.ts reads it back. */
export type LibraryCandidate = {
  id: string;
  name: string;
  caption: Caption;
  stats?: PaletteStats | null;
  consentCleared?: boolean;
  /** Epoch ms of the last post that used it; null when never used. */
  lastUsedAt?: number | null;
  usedCount?: number;
};

export type FreshMatch = {
  id: string;
  name: string;
  pillar: string;
  why: string;
  score: number;
  filters: string[];
  /** True when every fitting photograph had been used recently and the least-recent one was taken anyway. */
  repeated: boolean;
};

const MIN_SCORE = 0.35;

/**
 * The pillars the clinic's own rooms serve — consultation, portrait, team,
 * treatment room, reception, exterior, lab, equipment (lib/library-caption.ts
 * SUBJECT_PILLARS) — in the order to try them when a post's words name no
 * pillar, or name one the folder has nothing for. A post about the clinic
 * gets a photograph of the clinic before anything is generated: "I want them
 * picked up from the library."
 */
export const GENERAL_PILLARS = ['protocols', 'diagnosis', 'follow-up', 'recovery', 'prevention', 'supplementation', 'cancun'] as const;

/**
 * The best real photograph for a post, among the pillars its words name, that
 * has NOT been used in the last REUSE_WINDOW_DAYS — and only when every
 * fitting one has, the least recently used of them, said as a repeat.
 *
 * Pillars are tried in the order given (best first): a movement post gets a
 * movement photograph before a consultation one, even if the consultation one
 * is a better colour fit. Within a pillar the score is lib/library-match.ts's:
 * colour fit first, focus to break ties. The same rejections apply — the
 * cover rules, a patient with no release, an unmeasured or off-palette photo.
 */
export function pickFresh(candidates: readonly LibraryCandidate[], pillars: readonly string[], now = Date.now(), opts: { exclude?: readonly string[] } = {}): FreshMatch | null {
  const recent = now - REUSE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const excluded = new Set(opts.exclude || []);
  for (const pillar of pillars) {
    let fresh: FreshMatch | null = null;
    let stale: (FreshMatch & { lastUsedAt: number }) | null = null;
    for (const c of candidates) {
      if (excluded.has(c.id)) continue;
      const safe = coverSafe(c.caption);
      if (!safe.ok) continue;
      if (safe.needsConsent && !c.consentCleared) continue;
      const served = pillarsFor(c.caption);
      if (!served.includes(pillar)) continue;
      // Not yet colour-measured (ffmpeg was not there when it was read): not
      // refused. The brand filter measures and grades the photo at use
      // (lib/library-hero.ts) anyway; it merely ranks below one known to fit.
      const g = c.stats ? gradeFor(c.stats) : null;
      if (g && g.verdict === 'outside') continue;
      const fit = !g ? 0.6 : g.verdict === 'ready' ? 1 : Math.max(0, 1 - g.distance / 2);
      const score = Math.round((fit + (1 / served.length) * 0.25) * 100) / 100;
      if (score < MIN_SCORE) continue;
      const match: FreshMatch = {
        id: c.id, name: c.name, pillar, score, filters: g ? g.filters : [], repeated: false,
        why: `${c.caption.subjects.join(', ')} — ${!g ? 'graded at use' : g.verdict === 'ready' ? 'already in the palette' : 'graded into the palette'}`,
      };
      const usedAt = c.lastUsedAt ?? null;
      if (usedAt != null && usedAt > recent) {
        // Used lately: only the fallback, and the least recent of those wins.
        if (!stale || usedAt < stale.lastUsedAt) stale = { ...match, repeated: true, lastUsedAt: usedAt };
        continue;
      }
      if (!fresh || score > fresh.score) fresh = match;
    }
    if (fresh) return fresh;
    if (stale) { const { lastUsedAt: _at, ...rest } = stale; return rest; }
  }
  return null;
}

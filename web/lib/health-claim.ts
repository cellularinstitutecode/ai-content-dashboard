// web/lib/health-claim.ts
// Does this post say something about health that a study would have to back?
//
// WHY. The advertising rule makes every Instagram, Facebook and LinkedIn post
// carry a REF line citing a peer-reviewed study. For the weekly strategy's
// destination posts — "Air connectivity from the United States and Canada",
// "Hotel, dining, and low-impact activity options", "What a companion can do
// during the trip" — no study supports what the post says, so the writer cited
// a loosely related paper, or reached for a health claim so it could cite one.
// The clinic decided: those posts cite a study only when they make a health
// claim (lib/content-strategy.ts citation policy). This decides whether one did.
//
// CONSERVATIVE ON PURPOSE. A false "yes" keeps today's behaviour — the post
// needs its REF line. A false "no" would let an uncited health claim through.
// So anything that sounds like one counts: a body word, an outcome verb, a
// therapy, a condition, or "studies show".
//
// Pure: imports only ./compliance.ts, which imports this file back. The cycle is
// safe: each uses the other only inside function bodies, never at load time.
import { stripComplianceLines } from './compliance.ts';

const HEALTH_CLAIM = new RegExp(
  '\\b(' + [
    // outcomes
    'heal(s|ing|ed)?', 'improv\\w*', 'reduc\\w*', 'lower(s|ing|ed)?', 'boost\\w*', 'prevent\\w*', 'protect\\w*',
    'relie\\w*', 'restor\\w*', 'strengthen\\w*', 'enhanc\\w*', 'speed(s)? up', 'faster', 'benefit\\w*', 'effective\\w*',
    // the body
    'inflammat\\w*', 'immun\\w*', 'metabol\\w*', 'hormon\\w*', 'cortisol', 'nervous system', 'blood', 'circulat\\w*',
    'muscle\\w*', 'joint\\w*', 'bone\\w*', 'tissue\\w*', 'cells?', 'cellular (health|repair|function|energy|aging|ageing|regeneration)', 'brain', 'heart', 'oxygen\\w*', 'biomarker\\w*',
    'sleep quality', 'recover(y|ing|ies)?', 'repair\\w*', 'longevity', 'aging', 'ageing', 'energy levels?',
    // conditions and care
    'pain', 'symptom\\w*', 'disease\\w*', 'condition\\w*', 'disorder\\w*', 'injur\\w*', 'arthritis', 'diabet\\w*',
    'treat\\w*', 'therap\\w*', 'protocol\\w*', 'diagnos\\w*', 'clinical\\w*', 'medical\\w*', 'medication\\w*',
    'supplement\\w*', 'vitamin\\w*', 'nutrient\\w*', 'protein',
    'hbot', 'hyperbaric', 'red[- ]light', 'pemf', 'stem[- ]cells?', 'regenerat\\w*',
    // evidence talk
    'stud(y|ies)', 'research\\w*', 'evidence', 'scienc\\w*', 'proven',
  ].join('|') + ')\\b',
  'i',
);

/** The post as a reader reads it: no REF, no AVISO, no hashtags. */
function bodyOf(text: string): string {
  return stripComplianceLines(text)
    .split('\n')
    .filter((l) => !/^\s*(#\S+\s*)+$/.test(l))
    .join('\n')
    // The clinic's own name is not a claim. "Cellular" in it read as one, so a
    // logistics post that named the team — as the writer is told to, once —
    // lost its citation waiver and was refused at approval.
    .replace(/\bcellular\s+(hope\s+)?institute\b/gi, ' ');
}

/**
 * The words that made a post read as a health claim, each once, as written —
 * so a rewrite that has to claim nothing can be told exactly what to replace.
 */
export function healthClaimWords(text: string): string[] {
  const body = bodyOf(String(text || ''));
  const all = new RegExp(HEALTH_CLAIM.source, 'gi');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(all)) {
    const w = m[0];
    if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); out.push(w); }
  }
  return out;
}

/** True when the post says anything a study would have to back. When unsure: true. */
export function makesHealthClaim(text: string): boolean {
  const body = bodyOf(String(text || ''));
  if (!body.trim()) return false;
  return HEALTH_CLAIM.test(body);
}

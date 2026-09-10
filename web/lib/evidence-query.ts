// web/lib/evidence-query.ts
// Turning a video's subject into a literature search that actually returns
// something.
//
// This file exists because of a measured failure, not a guess. PubMed joins
// every term in a query with AND, so a query that reads like a sentence asks
// for papers containing ALL of it and finds nothing. Run against the live
// index while designing this:
//
//   "mesenchymal stem cell manufacturing quality control potency
//    donor variability clinical grade"          (7 terms)  ->     0 results
//   "mesenchymal stromal cell potency assay donor variability"
//                                               (5 terms)  ->    41 results
//
// Same subject, same index, same minute. The only difference was length. A
// search built from the video's title and keyword brief would naturally have
// run long, returned nothing every time, and looked exactly like "there is no
// research on this" — a silent failure of the most demoralising kind, because
// the feature would appear to work and simply never find anything.
//
// So the terms are capped, and there is a deliberate second, shorter query to
// fall back to. No imports: the test runner strips types and runs this file.

/**
 * The most AND-ed terms worth asking for.
 *
 * Five returned 41 results on the trial above; seven returned none. Four is one
 * inside the last figure known to work, which is where a cap belongs when the
 * cost of being too narrow is silence and the cost of being too broad is a
 * slightly less relevant paper.
 */
export const MAX_TERMS = 4;
/** The retry, when the first query finds nothing. */
export const BROAD_TERMS = 2;

/**
 * Words that match everything and therefore narrow nothing — but which cost a
 * whole AND clause each, and so are the difference between 41 results and 0.
 *
 * The clinic's own vocabulary is here for the same reason it is in
 * lib/opening-line.ts: "regenerative", "therapy", "treatment" and "clinic"
 * appear in every subject it films, so as search terms they only shrink the
 * result set without telling PubMed anything.
 */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'near', 'me',
  'best', 'cost', 'price', 'reviews', 'benefits', 'what', 'how', 'why', 'does', 'is', 'are',
  'reel', 'video', 'web', 'final', 'comp', 'corp', 'corporativo', 'corporate', 'horizontal', 'vertical', 'rodrigo',
  'clinic', 'clinical', 'treatment', 'treatments', 'therapy', 'therapies',
  'regenerative', 'medicine', 'medical', 'health', 'wellness', 'care', 'patient', 'patients',
]);

/** Significant, de-duplicated words, in order — the subject's own first. */
function terms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // PascalCase split before lowercasing. lib/video-copy.ts's videoSubject()
  // normally does this, so the caller passes "Final Comp Corporativo" rather
  // than "Reel_FinalCompCorporativo_Rodrigo" — but a caller that forgets would
  // otherwise search for the single nonsense token "finalcompcorporativo",
  // which matches nothing and looks like an absence of research.
  const split = String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  for (const w of split.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)) {
    if (w.length < 3 || NOISE.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export type EvidenceQuery = {
  /** The query to run first. Empty when there is nothing specific to ask. */
  primary: string;
  /** Shorter, for when `primary` finds nothing. Empty when it would repeat it. */
  broad: string;
};

/**
 * Build the search from what the video is about.
 *
 * The SUBJECT leads because it is what somebody typed when they named the clip,
 * and the keyword brief follows to sharpen it. Keywords alone would search for
 * whatever Semrush found — which is a search-volume ranking, not a clinical
 * one, and on one occasion was consumer red-light gear.
 */
export function evidenceQuery(subject: string, keywords: readonly string[] = []): EvidenceQuery {
  const fromSubject = terms(subject);
  const fromKeywords = terms(keywords.join(' '));
  const merged: string[] = [];
  for (const w of [...fromSubject, ...fromKeywords]) {
    if (!merged.includes(w)) merged.push(w);
  }
  const primary = merged.slice(0, MAX_TERMS);
  const broad = merged.slice(0, BROAD_TERMS);
  return {
    primary: primary.join(' '),
    // Only worth a second request when it is actually a different, wider net.
    broad: broad.length && broad.length < primary.length ? broad.join(' ') : '',
  };
}

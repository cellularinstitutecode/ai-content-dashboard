// web/lib/opening-line.ts
// Whether this caption starts like one the clinic has already published.
//
// The complaint that produced this file: "it started very similarly ... most of
// it ... seems like they're duplicates even though they're not." They were not
// duplicates. Nothing in the pipeline had ever read a previous caption, so no
// post could notice it was repeating one — every video was written in complete
// isolation, from a prompt carrying exactly ONE example opening sentence.
//
// A single example in a prompt is not an illustration, it is a template. Every
// post came back as a variation on "Safety in regenerative medicine starts long
// before a therapy reaches the patient": abstract noun, "in regenerative
// medicine", temporal claim. Worse, the instruction asked for a line that
// "reframes the subject" — a THESIS — and theses about a handful of related
// therapies converge by their nature. Two videos cannot share a concrete
// moment; they very easily share a thesis.
//
// So the fix has two halves and this file is the second one. The prompt asks
// for a concrete opening (lib/video-copy.ts). This measures whether it got one,
// so the ask can be enforced by lib/draft-defect.ts through the regeneration
// loop that already exists, rather than merely hoped for.
//
// No imports: the test runner strips types and runs this file directly.

/**
 * Words that carry no identity. Deliberately includes the clinic's own subject
 * vocabulary — "regenerative", "medicine", "therapy", "health" appear in almost
 * every caption, and counting them as evidence of similarity would mark every
 * pair of posts a duplicate.
 */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those',
  'we', 'our', 'us', 'you', 'your', 'they', 'their', 'what', 'when', 'where', 'which', 'who', 'how',
  'why', 'not', 'no', 'isnt', 'arent', 'dont', 'just', 'more', 'most', 'than', 'then', 'there',
  'here', 'about', 'into', 'over', 'under', 'before', 'after', 'every', 'each', 'any', 'all',
  'starts', 'start', 'begins', 'begin', 'long', 'much',
  // The house vocabulary. Present everywhere, so worthless as a fingerprint.
  'regenerative', 'medicine', 'medical', 'therapy', 'therapies', 'treatment', 'treatments',
  'health', 'wellness', 'clinic', 'patient', 'patients', 'care', 'body',
]);

/** The first sentence of a caption body, before the REF, AVISO and hashtags. */
export function openingLineOf(copy: string): string {
  const text = String(copy || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  // Stop at the first blank line: everything the clinic appends lives below one.
  const head = text.split(/\n\s*\n/)[0] || '';
  const firstLine = head.split('\n')[0] || '';
  // A sentence end is a full stop followed by a space or the end of the line.
  // "1,100" and "e.g." are why the lookahead is required rather than a bare split.
  const m = firstLine.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : firstLine).trim();
}

/**
 * The literal opening words, lowercased, punctuation gone — NOTHING filtered.
 *
 * The two tokenisations here are not redundant, and the first version of this
 * file was wrong because it used only the filtered one. "Safety in regenerative
 * medicine starts long before ..." reduces to ["safety", "reaches"] once the
 * house vocabulary is removed, so the very formula the clinic was complaining
 * about became invisible to the check meant to catch it. The words that make
 * two openings READ alike are largely stopwords and house vocabulary; the words
 * that tell two openings APART are not. So the stem is measured raw and the
 * overlap is measured filtered.
 */
export function stemOf(line: string): string[] {
  return String(line || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The identifying words of an opening line, in order, lowercased. */
export function signatureOf(line: string): string[] {
  return String(line || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE.has(w) && !/^\d+$/.test(w));
}

/**
 * How alike two openings are, 0-1.
 *
 * Jaccard over the identifying words — order-insensitive on purpose, because
 * "Safety starts before the therapy" and "Before the therapy comes safety" are
 * the same sentence to a reader and the whole complaint is about how they READ.
 */
export function similarity(a: string, b: string): number {
  const A = new Set(signatureOf(a));
  const B = new Set(signatureOf(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Above this, two openings read as the same sentence. */
export const SIMILARITY_LIMIT = 0.5;
/**
 * Identical LITERAL opening words this many deep is a repeat whatever the rest
 * of the sentence does. Five is enough to carry a formula ("safety in
 * regenerative medicine starts") and short enough that two posts genuinely
 * about the same piece of equipment are not condemned for naming it.
 */
export const STEM_WORDS = 5;

function sameStem(a: string, b: string): boolean {
  const x = stemOf(a).slice(0, STEM_WORDS);
  const y = stemOf(b).slice(0, STEM_WORDS);
  return x.length === STEM_WORDS && y.length === STEM_WORDS && x.every((w, i) => w === y[i]);
}

export type OpeningRepeat = {
  /** How alike, for the log — never for the corrective. See lib/draft-defect.ts. */
  score: number;
  /** Which signal fired, so a person reading the log knows what was matched. */
  by: 'stem' | 'overlap';
};

/**
 * Does this opening repeat one the clinic has already published?
 *
 * Two signals, because they catch different failures. `stem` is the literal
 * complaint — several posts opening on the same first few words. `overlap`
 * catches the same sentence rebuilt in a different order, which is what a model
 * asked to "vary the wording" produces when the underlying shape is unchanged.
 */
export function repeatsOpening(
  candidate: string,
  recent: readonly string[],
  limit = SIMILARITY_LIMIT,
): OpeningRepeat | null {
  const line = String(candidate || '').trim();
  if (!line || signatureOf(line).length < 2) return null;
  let worst: OpeningRepeat | null = null;
  for (const prior of recent) {
    if (!String(prior || '').trim()) continue;
    const score = similarity(line, prior);
    if (sameStem(line, prior)) return { score, by: 'stem' };
    if (score >= limit && (!worst || score > worst.score)) worst = { score, by: 'overlap' };
  }
  return worst;
}

// web/lib/claim-extract.ts
// The checkable statements in a post, and the search that would find a study
// for each one.
//
// "Verify / fix" (lib/post-citation-fix.ts) first asks the judge whether the
// cited paper supports THE POST, whole. For a caption about one therapy that
// is the right question. For a planner post — five paragraphs on supplement
// safety, regulation and timing — it is unanswerable: no single abstract
// covers all of it, so the judge said null to every paper, the search built
// from the caption's most frequent words found nothing on point, and the
// button reported "no study could be found" over a post that makes three
// perfectly citable statements. This is the step that takes the post apart
// into those statements, each with a PubMed query of its own.
//
// No imports, deliberately: the test runner strips types and runs this file.

export type CheckableClaim = {
  /** One concrete statement from the post, in the post's own terms. */
  claim: string;
  /** Three to six search words that would find a study about it. */
  query: string;
};

export const MAX_CLAIMS = 3;
const MAX_QUERY_WORDS = 6;

export const CLAIMS_SYSTEM =
  'You prepare medical advertising for fact-checking. You are given a social media post from a clinic. ' +
  'Pick out the statements in it that a published study could confirm or refute: a mechanism, a risk, an ' +
  'outcome, a statistic, a regulatory fact. Ignore the clinic’s opinions, invitations and hashtags.\n\n' +
  'For each statement write the claim in one plain sentence, and a PubMed search of three to six words ' +
  '(nouns and adjectives only, no quotes, no operators, no punctuation) that would find research about it. ' +
  'Put the most specific and most important statement first.\n\n' +
  'Answer with ONE line of JSON and nothing else: {"claims":[{"claim":"...","query":"..."}]} with at most ' +
  String(MAX_CLAIMS) + ' entries. When the post makes no checkable statement answer {"claims":[]}. Do not explain.';

export function claimsPrompt(text: string): string {
  return 'THE POST:\n\n' + String(text || '').trim() + '\n\nList its checkable statements. {"claims":[{"claim":"...","query":"..."}]}';
}

/** Search words only: what evidenceQuery can use, in the order given. */
export function cleanQuery(raw: unknown): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/["'()[\]{}:;,.!?*+~^|\\/]/g, ' ')
    .replace(/\b(and|or|not)\b/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, MAX_QUERY_WORDS)
    .join(' ');
}

/**
 * Read the answer, refusing to guess. Prose, a fenced block, a missing key,
 * an entry with no claim or no usable query: skipped or empty, never invented.
 */
export function parseClaims(text: string | null | undefined): CheckableClaim[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  const list = (parsed && typeof parsed === 'object' ? (parsed as { claims?: unknown }).claims : null);
  if (!Array.isArray(list)) return [];
  const out: CheckableClaim[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const claim = String((entry as { claim?: unknown }).claim || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const query = cleanQuery((entry as { query?: unknown }).query);
    if (claim.length < 12 || !query) continue;
    if (out.some((c) => c.claim === claim || c.query === query)) continue;
    out.push({ claim, query });
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

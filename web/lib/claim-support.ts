// web/lib/claim-support.ts
// Does the paper actually back the sentence it is printed under?
//
// THE GAP THIS CLOSES. The pipeline already finds real papers (lib/evidence.ts),
// already keeps their abstracts (lib/evidence-brief.ts), already builds the REF
// line from one of them (lib/citation-from-evidence.ts) and already verifies
// its DOI against Crossref (lib/citation.ts). Every one of those checks asks
// whether the citation EXISTS. None of them asks whether it SUPPORTS anything.
//
// So a post could say "three distinct wavelengths to support recovery" under a
// real, verified, relevance-ranked paper about red light therapy that never
// measured recovery at all. On a COFEPRIS-regulated advertisement, a reference
// that does not back the claim above it is the reference doing the opposite of
// its job: it lends authority the paper never gave.
//
// WHAT THIS IS NOT. It is not a gate. Finding the copy and the paper out of
// step starts a repair — swap the paper, search again at the claim, ask the
// writer for one more draft — and the post goes out either way. Nothing here
// can refuse a video; see lib/video-prepare.ts for the ladder.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly. The
// model call that uses these pieces lives in lib/ai.ts, where the provider keys
// and the retry policy already are.
import type { EvidenceItem } from './evidence-parse.ts';
import { captionBody } from './video-copy.ts';
import { frequentTerms } from './evidence-query.ts';

/** How many papers the judge is shown. The same three the writer was given. */
export const MAX_CANDIDATES = 3;
/** How much of each abstract the judge reads. */
export const MAX_ABSTRACT_CHARS = 1200;
/** How much of the copy is the claim. Longer than any caption the house writes. */
export const MAX_CLAIM_CHARS = 2000;

export type SupportVerdict =
  /** This paper (0-based into the list it was given) backs the claim. */
  | { status: 'supported'; index: number }
  /** The judge read them and none of them backs the claim. */
  | { status: 'none' }
  /** No answer worth trusting: unreachable, unparseable, out of range. */
  | { status: 'unchecked' };

/** What the draft ended up carrying, for the panel and the saved pack. */
export type ClaimSupportStamp = {
  /** 'supported' — checked and backed. 'swapped' — backed after changing paper.
   *  'unsupported' — checked, nothing backed it, published anyway (flagged).
   *  'unchecked' — the judge could not be asked. */
  status: 'supported' | 'swapped' | 'unsupported' | 'unchecked';
  /** The DOI the post went out with, when there is one. */
  doi: string | null;
};

/** Lines that are not a claim: the permit number, the reference, the tags. */
const WATCH_LINE = /^[ \t]*Watch:[ \t]*\S+[ \t]*$/gim;

/**
 * The part of a caption that actually asserts something.
 *
 * The AVISO, the REF line and the hashtag block are stripped by captionBody
 * (lib/video-copy.ts — the same regexes composeCaption uses, exported rather
 * than copied so the two cannot drift), and the "Watch:" link goes too. A judge
 * handed the permit number and the citation as part of the claim is being asked
 * a different question from the one that matters: whether the paper supports
 * the reference to itself is not in doubt.
 */
export function claimFrom(caption: string | null | undefined): string {
  const body = captionBody(String(caption || ''))
    .replace(WATCH_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body.length > MAX_CLAIM_CHARS ? body.slice(0, MAX_CLAIM_CHARS) : body;
}

/**
 * The search to run when NONE of the papers found backs the copy.
 *
 * Frequency, not order. lib/evidence-query.ts builds its query from the first
 * significant words of a short subject line, which is right for a title and
 * wrong for a paragraph: the first four content words of a caption are its
 * hook, and the hook is the one sentence deliberately written to be arresting
 * rather than precise. What a caption is ABOUT is what it keeps coming back to.
 */
export function claimQuery(claim: string | null | undefined): string {
  return frequentTerms(String(claim || '')).join(' ');
}

function trimAbstract(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_ABSTRACT_CHARS) return clean;
  const head = clean.slice(0, MAX_ABSTRACT_CHARS);
  const stop = head.lastIndexOf('. ');
  return (stop > MAX_ABSTRACT_CHARS / 2 ? head.slice(0, stop + 1) : head) + ' […]';
}

/**
 * The judge's standing instructions.
 *
 * Stated as a narrow question with a default of "no", because the failure this
 * exists to catch is the agreeable one: a model asked "is this relevant?" about
 * a real paper in the right field will say yes almost every time, and that
 * answer is exactly the gap — the paper WAS relevant, it simply did not show
 * what the copy said it showed.
 */
export const JUDGE_SYSTEM =
  'You check the references on medical advertising before it is published. A clinic has written a post, ' +
  'and it will be published with one published paper cited underneath it. Your only job is to say whether ' +
  'any of the papers offered actually supports what the post claims.\n\n' +
  'A paper SUPPORTS the post when its abstract reports findings about the same intervention AND the same ' +
  'kind of outcome the post describes, so that a careful reader would accept it as evidence for the point ' +
  'the post is making.\n\n' +
  'A paper does NOT support the post merely by being about the same field, the same organ, the same ' +
  'condition or the same clinic’s specialities. Being on topic is not being evidence. If the post claims ' +
  'an outcome the abstract never measured, or a certainty the abstract hedges, that paper does not support it.\n\n' +
  'Answer with ONE line of JSON and nothing else: {"supports": N} where N is the number of the paper that ' +
  'supports the post, or {"supports": null} when none of them does. Do not explain. Do not add prose. ' +
  'When in doubt, answer null: a wrong "yes" puts a reference under a claim it does not back, which is the ' +
  'thing this check exists to prevent.';

/** The papers and the claim, numbered from 1 the way the writer saw them. */
export function supportPrompt(claim: string, items: readonly EvidenceItem[]): string {
  const lines: string[] = ['THE POST:', '', String(claim || '').trim(), '', 'THE PAPERS:'];
  items.slice(0, MAX_CANDIDATES).forEach((item, i) => {
    lines.push('');
    lines.push('[' + (i + 1) + '] ' + String(item.title || '').trim());
    lines.push('ABSTRACT: ' + trimAbstract(item.abstract));
  });
  lines.push('');
  lines.push('Which paper supports what this post claims? {"supports": N} or {"supports": null}.');
  return lines.join('\n');
}

/**
 * Read the answer, refusing to guess.
 *
 * Every ambiguity resolves to 'unchecked' rather than to a paper: an index out
 * of range, a missing key, prose instead of JSON, a boolean. The caller treats
 * 'unchecked' as "carry on as before", so a confused model changes nothing —
 * while a confidently mis-parsed index would put the WRONG paper under the
 * claim, which is worse than the state this file exists to fix.
 */
export function parseSupportVerdict(text: string | null | undefined, count: number): SupportVerdict {
  const raw = String(text || '').trim();
  if (!raw) return { status: 'unchecked' };
  // The model was asked for bare JSON; a fenced block or a sentence around it
  // is common enough that failing on it would make the check silently useless.
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return { status: 'unchecked' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { status: 'unchecked' };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'unchecked' };
  const value = (parsed as Record<string, unknown>).supports;
  // An explicit "none". The whole point of asking.
  if (value === null || value === 'null' || value === 'none' || value === 0 || value === '0') {
    return { status: 'none' };
  }
  const n = typeof value === 'number' ? value : (typeof value === 'string' ? Number(value.trim()) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > Math.min(count, MAX_CANDIDATES)) return { status: 'unchecked' };
  return { status: 'supported', index: n - 1 };
}

/** The paper a verdict points at, or null. */
export function supportedItem(
  items: readonly EvidenceItem[] | null | undefined,
  verdict: SupportVerdict | null | undefined,
): EvidenceItem | null {
  if (!verdict || verdict.status !== 'supported') return null;
  return (items || [])[verdict.index] ?? null;
}

/** One short line for the draft when the check did not clear. */
export function claimSupportNote(stamp: ClaimSupportStamp | null | undefined): string {
  if (!stamp) return '';
  switch (stamp.status) {
    case 'unsupported':
      return 'The cited study does not clearly support this copy — worth a read before it publishes.';
    case 'unchecked':
      return 'The citation was not checked against the copy just now.';
    default:
      return '';
  }
}

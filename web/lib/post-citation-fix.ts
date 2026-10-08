// web/lib/post-citation-fix.ts
// The "Verify / fix" button on a post: does the study in the REF line back
// what this post says, and if not, which real study does?
//
// The Autopilot review card already has a FIX that climbs this ladder
// (lib/autopilot.ts fixCitation), but it works on a template run, and a post
// that has reached the calendar is a `posts` row with a draft behind it — the
// video-prepared ones especially, which never pass through a run at all.
// The September audit found exactly those on the calendar with a study about
// something else under them. This is the same ladder for that row.
//
//   1. Judge the paper cited NOW against the copy as it stands. The cited
//      paper is fetched by its DOI if the draft did not keep it, so the judge
//      reads the abstract rather than trusting a stale stamp.
//   2. No — so take the post apart into its checkable statements
//      (lib/claim-extract.ts), each with a search of its own, and judge
//      each one: a planner post that makes three citable points is not one
//      claim, and asking the judge about it whole got null every time.
//      Then, still nothing: search for what the post is about — the video's
//      subject and keywords, the transcript's vocabulary, the copy's.
//   3. Cite the one that backs it, on every channel of the draft and on the
//      post's text, after Crossref has confirmed the DOI.
//   4. None does: nothing is swapped (one wrong study for another is not a
//      fix) and the post is stamped 'unsupported', so the send doors refuse
//      it until somebody rewrites the claim or the citation.
//
// It never redrafts the copy: the words are the clinic's; the citation is ours.
import 'server-only';

import { extractCheckableClaims, judgeClaimSupport } from '@/lib/ai';
import { MAX_CANDIDATES, claimFrom, claimQuery, supportedItem, type ClaimSupportStamp, type SupportVerdict } from '@/lib/claim-support';
import { checkCompliance, refPolicyOf } from '@/lib/compliance';
import { refTitle, verifyDoi } from '@/lib/citation';
import { refLineFrom } from '@/lib/citation-from-evidence';
import { findByDoi, findEvidence } from '@/lib/evidence';
import { frequentTerms } from '@/lib/evidence-query';
import type { EvidenceItem } from '@/lib/evidence-parse';
import { swapRefLine } from '@/lib/fix-plan';
import { reportError } from '@/lib/report';

/** Every channel a pack can carry copy on. */
export const PACK_TEXT_KEYS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'blog'] as const;

export type CitationFixOutcome = {
  /** The post's text after the fix (unchanged when nothing was swapped). */
  text: string;
  /** Fields to merge into the draft's pack (empty when the draft needs no change). */
  packPatch: Record<string, unknown>;
  /** Did the citation change? */
  swapped: boolean;
  /** What the check concluded. */
  status: ClaimSupportStamp['status'];
  /** One or two sentences for the person who pressed the button. */
  note: string;
  /** The REF line now on the post, without its label. */
  ref: string | null;
};

const doiOf = (i: { doi?: string | null }) => String(i?.doi || '').toLowerCase();
const dedupe = (items: EvidenceItem[]) => items.filter((i, n, all) => all.findIndex((x) => doiOf(x) === doiOf(i)) === n);
const stampEvidence = (items: EvidenceItem[]) => items.slice(0, MAX_CANDIDATES).map((e) => ({ ...e, abstract: String(e.abstract || '').slice(0, 1200) }));

/**
 * Where to look for a study when the papers in hand do not back the copy.
 *
 * In the order most likely to find the RIGHT paper: what the video is about
 * (its title and the keyword brief), what was said in it, and only then the
 * caption — the caption is the thing that drifted, which is why we are here.
 */
export function searchSubjectsFor(pack: Record<string, unknown> | null, text: string): { subject: string; keywords: string[] }[] {
  const out: { subject: string; keywords: string[] }[] = [];
  const p = pack || {};
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const semrush = (p._semrush && typeof p._semrush === 'object' ? p._semrush : null) as { primary?: unknown; keywords?: unknown } | null;
  const keywords = Array.isArray(semrush?.keywords) ? semrush!.keywords.map((k) => String(k || '')).filter(Boolean) : [];
  const primary = typeof semrush?.primary === 'string' ? semrush.primary.trim() : '';
  if (title) out.push({ subject: title, keywords: primary ? [primary, ...keywords] : keywords });
  else if (primary) out.push({ subject: primary, keywords });
  const transcript = typeof p.transcript === 'string' ? p.transcript : '';
  const spoken = transcript ? frequentTerms(transcript).join(' ') : '';
  if (spoken) out.push({ subject: spoken, keywords: [] });
  const claim = claimFrom(text);
  const said = claim ? claimQuery(claim) : '';
  if (said) out.push({ subject: said, keywords: [] });
  return out.filter((s, n, all) => s.subject && all.findIndex((x) => x.subject === s.subject) === n);
}

/** How long the ladder may climb before it reports what it has. */
export const FIX_BUDGET_MS = 150_000;

/**
 * The post's own statements, one at a time.
 *
 * The judge is asked about ONE concrete claim — the question it was built to
 * answer — first against the papers in hand and then against a search written
 * for that claim. The first paper it accepts is the citation. Shared by the
 * button, the doors (lib/citation-autofix.ts) and the video pipeline.
 *
 * `candidates` comes back with the backing paper first when one was found;
 * `seen` is extended with every DOI looked at, so a caller's later searches
 * do not offer the judge the same paper twice.
 */
export async function findBackingByClaims(input: {
  text: string;
  candidates: EvidenceItem[];
  seen?: Set<string>;
  outOfTime?: () => boolean;
}): Promise<{ backing: EvidenceItem | null; candidates: EvidenceItem[]; backedClaim: string; verdict: SupportVerdict }> {
  const outOfTime = input.outOfTime || (() => false);
  const seen = input.seen || new Set(input.candidates.map(doiOf));
  let candidates = input.candidates;
  let verdict: SupportVerdict = { status: 'unchecked' };
  // AT ONCE, not one after another. This used to judge, search and judge
  // again for each statement in turn — a four-statement post was four
  // rounds of the judge's latency plus four searches, end to end, and the
  // card routinely ran out of time before the correction. Every statement
  // now gets its judge call and its search in the same breath; the first
  // statement in the post's own order with a backing paper still wins, so
  // the answer is the same, only sooner.
  const claims = (await extractCheckableClaims(input.text)).slice(0, MAX_CLAIMS);
  if (!claims.length || outOfTime()) return { backing: null, candidates, backedClaim: '', verdict };
  if (candidates.length) {
    const inHand = await Promise.all(claims.map((c) => judgeClaimSupport({ claim: c.claim, items: candidates })));
    for (let i = 0; i < claims.length; i++) {
      const hit = supportedItem(candidates, inHand[i]);
      if (hit) return { backing: hit, candidates: dedupe([hit, ...candidates]), backedClaim: claims[i].claim, verdict: inHand[i] };
    }
  }
  if (outOfTime()) return { backing: null, candidates, backedClaim: '', verdict };
  const searched = await Promise.all(claims.map(async (c) => {
    try { return (await findEvidence(c.query)).filter((i) => doiOf(i)); } catch (err) { reportError('post-citation-fix:claim-search', err); return [] as EvidenceItem[]; }
  }));
  // A paper two searches both returned is judged once, for the first statement that found it.
  const fresh = searched.map((found) => {
    const mine = found.filter((i) => !seen.has(doiOf(i)));
    mine.forEach((i) => seen.add(doiOf(i)));
    return mine;
  });
  if (outOfTime()) return { backing: null, candidates, backedClaim: '', verdict };
  const judged = await Promise.all(claims.map((c, i) => (fresh[i].length ? judgeClaimSupport({ claim: c.claim, items: fresh[i] }) : Promise.resolve(null))));
  for (let i = 0; i < claims.length; i++) {
    const retried = judged[i];
    if (!retried) continue;
    const hit = supportedItem(fresh[i], retried);
    if (hit) { candidates = dedupe([hit, ...candidates]); return { backing: hit, candidates, backedClaim: claims[i].claim, verdict: retried }; }
    if (retried.status !== 'unchecked') verdict = retried;
  }
  return { backing: null, candidates, backedClaim: '', verdict };
}

/** Statements researched per press. Past four, a post is a list, and the fourth search rarely finds what the first three did not. */
const MAX_CLAIMS = 4;

export async function fixPostCitation(input: {
  text: string;
  pack: Record<string, unknown> | null;
  aviso?: string | null;
  budgetMs?: number;
  /**
   * The caller has JUST judged the papers in hand against the copy and found
   * none backs it (the Autopilot's rung 1, lib/autopilot.ts fixCitation).
   * Rung 1 here would ask the judge the same question about the same papers
   * a second time; it is skipped and the research starts at the statements.
   */
  skipInHand?: boolean;
}): Promise<CitationFixOutcome> {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > (input.budgetMs ?? FIX_BUDGET_MS);
  const text = String(input.text || '');
  const pack = input.pack || {};
  const current = checkCompliance(text, input.aviso ?? undefined, { refPolicy: refPolicyOf(pack) });
  const citedDoi = String(current.doi || '').toLowerCase();
  const claim = claimFrom(text);
  const currentRef = current.ref ? String(current.ref).replace(/^REF:\s*/i, '') : null;

  const stampOn = (status: ClaimSupportStamp['status'], doi: string | null, evidence: EvidenceItem[], texts: Record<string, string> = {}) => {
    const stamp: ClaimSupportStamp = { status, doi };
    // Both spellings: the video pipeline writes `claimSupport`, the Autopilot
    // writes `_claimSupport`, and every door reads whichever the draft has.
    const patch: Record<string, unknown> = { ...texts, _claimSupport: stamp };
    if ('claimSupport' in pack || pack.kind === 'video') patch.claimSupport = stamp;
    if (evidence.length) patch._evidence = stampEvidence(evidence);
    return patch;
  };

  if (!claim) {
    return { text, packPatch: {}, swapped: false, status: 'unchecked', note: 'This post has no copy to check a study against.', ref: currentRef };
  }

  // The papers the judge can read: what the draft kept, plus the cited one.
  const kept = (Array.isArray(pack._evidence) ? pack._evidence : []) as EvidenceItem[];
  let candidates = dedupe(kept.filter((i) => doiOf(i)));
  if (citedDoi && !candidates.some((i) => doiOf(i) === citedDoi)) {
    const cited = await findByDoi(citedDoi).catch(() => null);
    if (cited) candidates = dedupe([cited, ...candidates]);
  }

  // RUNG 1 — does the paper cited, or one already in hand, back the copy?
  // (Not asked again when the caller just did: see `skipInHand`.)
  let verdict: SupportVerdict = { status: 'unchecked' };
  if (candidates.length) verdict = input.skipInHand ? { status: 'none' } : await judgeClaimSupport({ claim, items: candidates });
  let backing = supportedItem(candidates, verdict);

  // RUNG 2 — the post's own statements, one at a time (findBackingByClaims).
  /** The statement the chosen paper backs, for the note. */
  let backedClaim = '';
  const seen = new Set(candidates.map(doiOf));
  if (!backing && !outOfTime()) {
    const byClaims = await findBackingByClaims({ text, candidates, seen, outOfTime });
    if (byClaims.backing) {
      backing = byClaims.backing;
      candidates = byClaims.candidates;
      backedClaim = byClaims.backedClaim;
      verdict = { status: 'supported', index: candidates.findIndex((i) => doiOf(i) === doiOf(byClaims.backing!)) };
    } else if (byClaims.verdict.status !== 'unchecked') {
      verdict = byClaims.verdict;
    }
  }

  // RUNG 2b — search for what the post is about: every subject at once, the
  // judge asked about each set in the same breath, the first subject with a
  // backing paper wins (same answer as one at a time, without the wait).
  if (!backing && !outOfTime()) {
    const subjects = searchSubjectsFor(pack, text);
    const searched = await Promise.all(subjects.map(async (s) => {
      try { return (await findEvidence(s.subject, s.keywords)).filter((i) => doiOf(i)); } catch (err) { reportError('post-citation-fix:search', err); return [] as EvidenceItem[]; }
    }));
    const fresh = searched.map((found) => {
      const mine = found.filter((i) => !seen.has(doiOf(i)));
      mine.forEach((i) => seen.add(doiOf(i)));
      return mine;
    });
    if (!outOfTime()) {
      const judged = await Promise.all(fresh.map((found) => (found.length ? judgeClaimSupport({ claim, items: found }) : Promise.resolve(null))));
      for (let i = 0; i < fresh.length; i++) {
        const retried = judged[i];
        if (!retried) continue;
        const hit = supportedItem(fresh[i], retried);
        if (hit) { backing = hit; candidates = dedupe([hit, ...candidates]); verdict = retried; break; }
        if (retried.status === 'unchecked') { verdict = retried; break; }
      }
    }
  }

  if (verdict.status === 'unchecked') {
    return {
      text, packPatch: stampOn('unchecked', citedDoi || null, candidates), swapped: false, status: 'unchecked',
      note: 'The citation could not be checked just now (the checker did not answer). Nothing was changed — try again in a moment.',
      ref: currentRef,
    };
  }

  // RUNG 3 — cite the paper that backs it.
  if (backing) {
    if (doiOf(backing) === citedDoi) {
      return {
        text, packPatch: stampOn('supported', backing.doi, candidates), swapped: false, status: 'supported',
        note: 'Verified: the cited study supports what this post says. Nothing needed changing.',
        ref: currentRef,
      };
    }
    const checked = await verifyDoi(backing.doi, { expectedTitle: backing.title });
    if (checked.status === 'not_found' || checked.status === 'mismatch') {
      return {
        text, packPatch: stampOn('unsupported', citedDoi || null, candidates), swapped: false, status: 'unsupported',
        note: 'A study that supports this post was found, but Crossref could not confirm its DOI, so the citation was left as it is. Try again in a moment.',
        ref: currentRef,
      };
    }
    const line = refLineFrom(backing);
    const texts: Record<string, string> = {};
    for (const key of PACK_TEXT_KEYS) {
      const t = pack[key];
      if (typeof t === 'string' && t.trim()) texts[key] = swapRefLine(t, line);
    }
    const nextText = swapRefLine(text, line);
    const ref = line.replace(/^REF:\s*/, '');
    return {
      text: nextText, packPatch: stampOn('swapped', backing.doi, candidates, texts), swapped: true, status: 'swapped',
      note: (citedDoi ? 'The cited study did not support this post. ' : 'This post had no verifiable citation. ') + 'Replaced the citation with ' + ref +
        (backedClaim ? ' \u2014 it backs the post\u2019s statement that ' + backedClaim.replace(/\.$/, '').replace(/^[A-Z]/, (m) => m.toLowerCase()) + '.' : ''),
      ref,
    };
  }

  // RUNG 4 — nothing found backs the copy as written.
  if (outOfTime()) {
    return {
      text, packPatch: stampOn('unsupported', citedDoi || null, candidates), swapped: false, status: 'unsupported',
      note: 'No study found so far supports what this post says, and the search ran out of time. The citation was left as it is; press Verify / fix again to keep looking.',
      ref: currentRef,
    };
  }
  return {
    text, packPatch: stampOn('unsupported', citedDoi || null, candidates), swapped: false, status: 'unsupported',
    note: 'No study could be found that supports what this post says' + (citedDoi ? ', and the one cited does not either' : '') +
      '. The citation was left as it is and the post is marked unsupported: it will not be approved or sent until the claim or the citation is rewritten' +
      (refTitle(current.ref) ? ' (currently cites "' + refTitle(current.ref) + '")' : '') + '.',
    ref: currentRef,
  };
}

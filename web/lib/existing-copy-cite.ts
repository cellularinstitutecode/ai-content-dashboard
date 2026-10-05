// web/lib/existing-copy-cite.ts
// COPY A PERSON WROTE, MADE SENDABLE: the AVISO line, and a REF line found
// by research when the copy makes a health claim and cites nothing.
//
// WHY. A row with copy and a video was queued "exactly as the sheet has it",
// and the sheet's copy carries neither line — nobody writing in a spreadsheet
// types a DOI. The nightly sweep and "Attach videos" sent such drafts to
// Metricool; the composer refused to send the same copy ("YouTube, LinkedIn
// and TikTok posts need a REF line citing a scientific study, with a DOI");
// and nothing anywhere researched the citation. The person then pressed
// Prepare, which does not rewrite copy that exists, and saw nothing change.
//
// WHAT CHANGES, AND WHAT DOES NOT. The body of the copy is still the
// person's, word for word. Two lines are appended when missing, exactly as
// the writer appends them to copy it writes itself: the AVISO DE PUBLICIDAD
// line, and — only when the copy makes a health claim, and only when a real
// study backs what it says — a REF line with a verified DOI, found by the
// same ladder the calendar's "Verify / fix" climbs (lib/post-citation-fix.ts):
// the post's own statements one at a time, then its subject. No study found:
// the copy is left with its AVISO and no REF, the draft is stamped
// 'unsupported' so the send doors hold it, and the note says so.
//
// THE RULE FOR THE REF LINE is the clinic's: a post cites a study when it
// makes a health claim (lib/health-claim.ts decides, on the text). Copy that
// makes none — a reel about what to ask a clinic, a travel note — needs no
// citation and goes to Metricool as it is, with its AVISO. The policy is
// stamped on the draft ('if-health-claim'), so the send doors read the same
// rule; under it a missing REF is waived only when the text itself makes no
// claim, never by the stamp alone.
//
// The sheet's COPY cell is never written. The REF column beside it is.
import 'server-only';

import type { ComplianceStamp } from '@/lib/ai';
import { avisoForUser } from '@/lib/compliance-gate';
import { checkCompliance, ensureAviso } from '@/lib/compliance';
import { makesHealthClaim } from '@/lib/health-claim';
import { fixPostCitation } from '@/lib/post-citation-fix';
import { reportError } from '@/lib/report';

/** How long the research may take for one row: the sweep queues twenty of these a run inside its own budget. */
export const CITE_EXISTING_BUDGET_MS = 60_000;

export type CitedCopy = {
  /** The copy to send: the person's words, with the AVISO line and (when found) the REF line. */
  text: string;
  /** The reference now on the copy, without its "REF:" label; null when none. */
  ref: string | null;
  /** 'kept' — it already carried a usable REF; 'cited' — one was found and added; 'none' — needs one and none was found; 'not_needed' — no health claim, so no REF is required. */
  outcome: 'kept' | 'cited' | 'none' | 'not_needed';
  /** The claim-support verdict to stamp on the draft (lib/claim-support.ts statuses), or null when nothing was checked. */
  claimSupport: { status: 'supported' | 'swapped' | 'unsupported' | 'unchecked'; doi: string | null } | null;
  /** One sentence for the register and the panel. */
  note: string;
  /** The compliance stamp for the draft's pack: the policy the copy was checked under, so every door reads the same rule. */
  compliance: ComplianceStamp;
};

const POLICY = 'if-health-claim' as const;

/**
 * The person's copy, with its compliance lines. Never throws: a failure in
 * the research leaves the copy with its AVISO and says so.
 */
export async function citeExistingCopy(opts: {
  userId: string;
  text: string;
  /** The video's title — the subject the research searches when the statements alone find nothing. */
  title?: string | null;
  budgetMs?: number;
}): Promise<CitedCopy> {
  const aviso = await avisoForUser(opts.userId);
  const withAviso = ensureAviso(String(opts.text || '').trim(), aviso);
  const check = checkCompliance(withAviso, aviso, { refPolicy: POLICY });
  const stamp = (text: string, citation: ComplianceStamp['citation']): ComplianceStamp => {
    const c = checkCompliance(text, aviso, { refPolicy: POLICY });
    return { aviso, instagram: c, facebook: c, citation, refPolicy: POLICY, regenerated: false };
  };
  // A REF line with a DOI is already there: the person cited it. Kept as written;
  // whether it backs the copy is the doors' question, as for every post.
  if (check.ref && check.doi) {
    return { text: withAviso, ref: check.ref, outcome: 'kept', claimSupport: null, note: 'The copy already cites ' + check.ref + '.', compliance: stamp(withAviso, null) };
  }
  if (!makesHealthClaim(withAviso)) {
    return {
      text: withAviso, ref: null, outcome: 'not_needed', claimSupport: null,
      note: 'The copy makes no health claim, so it needs no citation and can be sent as it is.',
      compliance: stamp(withAviso, { status: 'not_required', doi: null, title: null, year: null }),
    };
  }
  try {
    const fix = await fixPostCitation({
      text: withAviso,
      pack: { title: String(opts.title || '').trim(), kind: 'video' },
      aviso,
      budgetMs: opts.budgetMs ?? CITE_EXISTING_BUDGET_MS,
    });
    if (fix.swapped && fix.ref) {
      const doi = checkCompliance(fix.text, aviso).doi;
      // Crossref confirmed the DOI before fixPostCitation cited it.
      return { text: fix.text, ref: fix.ref, outcome: 'cited', claimSupport: { status: 'swapped', doi }, note: 'Cited ' + fix.ref + ' — found by research; the copy itself is unchanged.', compliance: stamp(fix.text, { status: 'verified', doi, title: null, year: null }) };
    }
    return {
      text: withAviso, ref: null, outcome: 'none',
      claimSupport: { status: fix.status === 'unchecked' ? 'unchecked' : 'unsupported', doi: null },
      compliance: stamp(withAviso, null),
      note: fix.status === 'unchecked'
        ? 'The citation search did not answer just now; the copy was queued without a REF line and the doors will hold it until one is added.'
        : 'No study was found that backs what this copy says; it was queued without a REF line and the doors will hold it until the claim is softened or a source is added.',
    };
  } catch (e) {
    reportError('existing-copy:cite', e);
    return { text: withAviso, ref: null, outcome: 'none', claimSupport: { status: 'unchecked', doi: null }, note: 'The citation search failed just now; the copy was queued without a REF line.', compliance: stamp(withAviso, null) };
  }
}

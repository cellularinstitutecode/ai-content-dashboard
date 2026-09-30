// web/lib/strategy-claim-support.ts
// Does the paper in a strategy post's REF line support what the post says?
//
// One judge for every strategy post, wherever it is written: the Autopilot's
// score step (lib/autopilot.ts) and the preview a dropped strategy writes as
// soon as it is read (app/api/templates/strategy-upload/route.ts). The two
// used to differ — the preview was written, saved and shown with no judge
// at all — so a post could read as finished in the panel and then be held
// at the door for the very citation nobody had checked.
//
// Asked only of papers fetched for this post (pack._evidence) — the judge
// reads their abstracts, and cannot judge a paper it has never seen, so a DOI
// the writer recalled from elsewhere is 'unchecked', not a failure. The judge
// picking a DIFFERENT paper, or none, is 'unsupported'. A post with no REF
// line has nothing to judge (null). Never throws.
import 'server-only';

import { judgeClaimSupport } from '@/lib/ai';
import { checkCompliance } from '@/lib/compliance';
import { claimFrom, type ClaimSupportStamp } from '@/lib/claim-support';
import type { EvidenceItem } from '@/lib/evidence-brief';
import { reportError } from '@/lib/report';

export async function strategyClaimSupport(pack: Record<string, unknown>): Promise<ClaimSupportStamp | null> {
  try {
    const items = (pack._evidence as EvidenceItem[] | undefined) || [];
    const caption = String(pack.instagram || pack.facebook || '');
    const cited = checkCompliance(caption).doi;
    if (!cited) return null;
    const index = items.findIndex((i) => String(i.doi || '').toLowerCase() === cited.toLowerCase());
    if (index < 0 || !items.length) return { status: 'unchecked', doi: cited };
    const claim = claimFrom(caption);
    const verdict = await judgeClaimSupport({ claim, items });
    if (verdict.status === 'unchecked') return { status: 'unchecked', doi: cited };
    if (verdict.status === 'supported' && verdict.index === index) return { status: 'supported', doi: cited };
    return { status: 'unsupported', doi: cited };
  } catch (err) {
    reportError('strategy:claim-support', err);
    return null;
  }
}

/** One line for a person, from the judge's stamp as it now stands. */
export function citationVerdictLine(status: string | null | undefined, cited: boolean): string {
  switch (String(status || '').toLowerCase()) {
    case 'supported': return 'Citation checked: the study in the REF line backs what the post says.';
    case 'swapped': return 'Citation fixed: the REF line was swapped for a study that backs what the post says.';
    case 'unsupported': return 'Citation not approved: no study found that backs this claim — the post is held until it is fixed.';
    case 'unchecked': return 'Citation verified to exist, but whether it backs the claim could not be judged just now — it is judged again at the door.';
    default: return cited ? 'Citation present.' : 'No citation needed: the post makes no health claim.';
  }
}

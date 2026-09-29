// web/lib/citation-autofix.ts
// "Verify / fix", by default, at every door a post goes through.
//
// The button (lib/post-citation-fix.ts) exists for a person to press. This is
// the same ladder run WITHOUT anybody pressing it: when a post is about to be
// approved, sent for review, published from a video or approved by the
// Autopilot, and the judge has not already said its citation backs the copy,
// the citation is checked and, if a better study is found, swapped — on the
// text being sent and on every channel of the draft — before the compliance
// gate looks at it. The button stays as the safety net.
//
// Only a post that CITES something is checked. A post with no REF line is the
// compliance gate's business (it refuses, or waives under 'if-health-claim');
// inventing a citation for a post that made no claim would be the opposite of
// what this is for.
//
// Fails open: no key, a timeout, a database hiccup — the post goes on to the
// gate exactly as it was, with whatever stamp it had.
import 'server-only';

import { claimSupportOf } from '@/lib/citation-gate';
import { checkCompliance } from '@/lib/compliance';
import { fixPostCitation } from '@/lib/post-citation-fix';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type AutoFixResult = {
  /** The text to send: the same as given, or with the REF line swapped. */
  text: string;
  /** The draft's pack after the fix (the same object when nothing changed). */
  pack: Record<string, unknown> | null;
  /** The judge's verdict as it now stands on the pack. */
  status: string | null;
  swapped: boolean;
  /** What happened, for a log line; '' when nothing needed doing. */
  note: string;
};

/** How long a door may spend on this before sending the post on as it is. */
export const DOOR_BUDGET_MS = 60_000;

export async function autoFixCitation(input: {
  userId: string;
  draftId?: string | null;
  text: string;
  pack: Record<string, unknown> | null | undefined;
  budgetMs?: number;
}): Promise<AutoFixResult> {
  const text = String(input.text || '');
  const pack = (input.pack && typeof input.pack === 'object' ? input.pack : null) as Record<string, unknown> | null;
  const status = claimSupportOf(pack);
  const unchanged: AutoFixResult = { text, pack, status, swapped: false, note: '' };

  const cited = String(checkCompliance(text).doi || '').toLowerCase();
  if (!cited) return unchanged;
  // Already judged, on this very DOI: nothing to do.
  const stampDoi = String(
    ((pack?._claimSupport || pack?.claimSupport) as { doi?: unknown } | null | undefined)?.doi || '',
  ).toLowerCase();
  if ((status === 'supported' || status === 'swapped') && stampDoi === cited) return unchanged;

  try {
    const fix = await fixPostCitation({ text, pack, budgetMs: input.budgetMs ?? DOOR_BUDGET_MS });
    let nextPack = pack;
    if (input.draftId && Object.keys(fix.packPatch).length) {
      const db = supabaseAdmin();
      const { data: fresh } = await db.from('drafts').select('pack').eq('id', input.draftId).eq('user_id', input.userId).maybeSingle();
      const current = ((fresh as { pack?: Record<string, unknown> } | null)?.pack || pack || {}) as Record<string, unknown>;
      nextPack = { ...current, ...fix.packPatch };
      const { error } = await db.from('drafts').update({ pack: nextPack }).eq('id', input.draftId).eq('user_id', input.userId);
      if (error) {
        reportError('citation-autofix:save', error, { draftId: input.draftId });
        // The swap is not on the draft, so it must not be on the post either:
        // the two would disagree about which study the post cites.
        return unchanged;
      }
    } else if (Object.keys(fix.packPatch).length) {
      nextPack = { ...(pack || {}), ...fix.packPatch };
    }
    return { text: fix.text, pack: nextPack, status: fix.status, swapped: fix.swapped, note: fix.note };
  } catch (err) {
    reportError('citation-autofix', err, { draftId: String(input.draftId || '') });
    return unchanged;
  }
}

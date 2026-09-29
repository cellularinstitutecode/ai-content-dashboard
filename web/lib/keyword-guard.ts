// web/lib/keyword-guard.ts
// No post goes out without keywords: the last check, at the doors.
//
// Every drafting path now researches through the ladder (lib/ai.ts
// keywordLadder) and stamps the pack. This is for what those paths did not
// write — drafts from before the ladder, copy a person typed, a pack whose
// stamp was lost in an edit. On its way out, a post whose draft carries no
// keywords gets them backfilled from its own text: the model's terms first,
// then the text's own words (lib/keyword-fallback.ts), stamped as estimates
// and saved on the draft. Never Semrush: a door must not spend units.
//
// Fails open: a backfill that cannot be done leaves the post exactly as it
// was. This is a fallback, not a gate — the gate is at the writer.
import 'server-only';

import { keywordLadder } from '@/lib/ai';
import { hasKeywords } from '@/lib/keyword-fallback';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type KeywordGuardResult = {
  /** The pack after the backfill (the same object when nothing changed). */
  pack: Record<string, unknown> | null;
  /** Did the draft get keywords it did not have? */
  backfilled: boolean;
  /** The keywords the post now carries, from any source. */
  keywords: string[];
};

function stampOf(pack: Record<string, unknown> | null): { keywords?: string[] } | null {
  const s = pack?._semrush;
  return s && typeof s === 'object' ? (s as { keywords?: string[] }) : null;
}

export async function ensureKeywords(input: {
  userId: string;
  draftId?: string | null;
  text: string;
  pack: Record<string, unknown> | null | undefined;
}): Promise<KeywordGuardResult> {
  const pack = (input.pack && typeof input.pack === 'object' ? input.pack : null) as Record<string, unknown> | null;
  const existing = stampOf(pack);
  const unchanged: KeywordGuardResult = { pack, backfilled: false, keywords: existing?.keywords || [] };
  if (hasKeywords(existing)) return unchanged;
  const text = String(input.text || '').trim();
  if (!text) return unchanged;

  try {
    // The first line is the subject; the whole text is what is said about it.
    const subject = text.split('\n').map((l) => l.trim()).find(Boolean) || text.slice(0, 120);
    const found = await keywordLadder(subject, { context: text, skipSemrush: true });
    if (!hasKeywords(found.stamp)) return unchanged;
    const stamp = { ...found.stamp, reason: 'backfilled_at_send' };
    let next: Record<string, unknown> = { ...(pack || {}), _semrush: stamp };
    if (input.draftId) {
      const db = supabaseAdmin();
      const { data: fresh } = await db.from('drafts').select('pack').eq('id', input.draftId).eq('user_id', input.userId).maybeSingle();
      const current = ((fresh as { pack?: Record<string, unknown> } | null)?.pack || pack || {}) as Record<string, unknown>;
      next = { ...current, _semrush: stamp };
      const { error } = await db.from('drafts').update({ pack: next }).eq('id', input.draftId).eq('user_id', input.userId);
      if (error) reportError('keyword-guard:save', error, { draftId: input.draftId });
    }
    return { pack: next, backfilled: true, keywords: stamp.keywords };
  } catch (err) {
    reportError('keyword-guard', err, { draftId: String(input.draftId || '') });
    return unchanged;
  }
}

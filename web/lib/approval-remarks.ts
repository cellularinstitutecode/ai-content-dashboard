// web/lib/approval-remarks.ts
// A remark is what Approve says INSTEAD of refusing when the only thing wrong
// is the citation.
//
// The doors used to refuse a post whose REF line was missing, had no DOI,
// named a study Crossref does not know, pointed at a different paper, or did
// not back the claim — and every one of those stopped the reviewer at the
// card with nothing to press but Fix. The clinic's decision is the reviewer's
// to make right there: approve it anyway, with the problem written down
// where it can be read later. So those checks still run, still say what
// they found, and their findings travel with the draft as remarks rather
// than as a refusal. The advertising notice (AVISO) is not a remark: it is
// stamped automatically and a wrong permit number still refuses.
//
// Pure helpers first (the tests read this file directly); the database
// helper at the bottom is the one both doors call.

export type ApprovalRemark = { at: string; text: string };

const MAX_REMARKS = 12;

/** The remarks already on a pack, oldest first, tolerating any older shape. */
export function approvalRemarksOf(pack: unknown): ApprovalRemark[] {
  const raw = (pack as { _approvalRemarks?: unknown } | null | undefined)?._approvalRemarks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === 'object' ? { at: String((r as ApprovalRemark).at || ''), text: String((r as ApprovalRemark).text || '').trim() } : null))
    .filter((r): r is ApprovalRemark => Boolean(r && r.text));
}

/** The pack with these remarks appended (newest last, the oldest dropped past the cap). */
export function withApprovalRemarks<T extends Record<string, unknown>>(pack: T, remarks: readonly string[], at: string = new Date().toISOString()): T {
  const fresh = remarks.map((t) => String(t || '').trim()).filter(Boolean).map((text) => ({ at, text }));
  if (!fresh.length) return pack;
  const all = [...approvalRemarksOf(pack), ...fresh].slice(-MAX_REMARKS);
  return { ...pack, _approvalRemarks: all };
}

/** One sentence for a card or a log line: "Approved with a remark on the citation — …". */
export function approvalRemarkNote(remarks: readonly string[]): string {
  const list = remarks.map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return '';
  return 'Approved with ' + (list.length === 1 ? 'a remark' : list.length + ' remarks') + ' on the citation — ' + list.join(' ');
}

// Either Supabase client (service-role or the user's own). Typed loosely on
// purpose: spelling the query-builder chain out structurally made the
// compiler recurse through supabase-js's generics and give up.
type DraftsClient = { from: (table: 'drafts') => any };

/**
 * Write the remarks onto the draft behind a post, so the card, the queue and
 * the next reviewer can read why it went out as it did. Best-effort: a
 * database hiccup must never undo an approval that already happened.
 */
export async function recordApprovalRemarks(
  db: DraftsClient,
  args: { draftId: string | null | undefined; userId: string; remarks: readonly string[] },
): Promise<boolean> {
  const list = args.remarks.map((t) => String(t || '').trim()).filter(Boolean);
  if (!args.draftId || !list.length) return false;
  try {
    const { data } = await db.from('drafts').select('pack').eq('id', args.draftId).eq('user_id', args.userId).maybeSingle();
    const pack = (data?.pack && typeof data.pack === 'object' ? data.pack : {}) as Record<string, unknown>;
    const { error } = await db.from('drafts').update({ pack: withApprovalRemarks(pack, list) }).eq('id', args.draftId).eq('user_id', args.userId);
    return !error;
  } catch {
    return false;
  }
}

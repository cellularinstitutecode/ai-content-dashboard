// web/lib/cover-redo.ts
// Which covers were made before the title learned to stay off the people,
// and what their record becomes once they are redone.
//
// The cover rule changed on 3 November 2026 (lib/title-cover-layout.ts): no
// wash, the title above the people or at the bottom, never on a face. Every
// titled cover made before that keeps the old look until it is re-rendered,
// and Apply title one draft at a time is sixty presses. The "Redo old
// covers" button (app/ImageStudio.tsx → app/api/drafts/covers) does them
// in one go, for free: the clean photograph is kept beside every cover.
//
// Pure, so it is unit-tested; the route does the fetching and the storing.

/** When the new cover rule went live. A titled cover made before this is redone. */
export const COVER_RULE_SINCE = '2026-11-03T00:44:00Z';

export type RedoableImage = {
  url?: string | null;
  createdAt?: string | null;
  titled?: { title?: string; photoUrl?: string | null } | null;
  /** Stamped once the cover has been redone under the new rule. */
  coverRedone?: boolean | null;
  verification?: { status?: string; issues?: string[]; advisory?: string[] } | null;
};

/** A titled cover made before the rule, not yet redone. */
export function isOldCover(image: RedoableImage | null | undefined): boolean {
  if (!image || !image.url) return false;
  if (image.coverRedone === true) return false;
  const kept = String(image.titled?.photoUrl || '').trim();
  const title = String(image.titled?.title || '').trim();
  if (!kept || !title) return false;
  const made = String(image.createdAt || '').trim();
  // No date on the record: made before the date was recorded, so before the rule.
  return !made || made < COVER_RULE_SINCE;
}

const HEAD_FLAG = /head reaches into the title area/i;

/**
 * The verification without the head flag. A head high in the frame was a
 * defect when the title always sat at the top; it is not one now, and a
 * cover redone under the new rule should not keep wearing that warning.
 * Any other finding stays, and the status follows what is left.
 */
export function withoutHeadFlag<T extends { status?: string; issues?: string[] }>(v: T | null | undefined): T | null | undefined {
  if (!v || !Array.isArray(v.issues)) return v;
  const issues = v.issues.filter((i) => !HEAD_FLAG.test(String(i)));
  if (issues.length === v.issues.length) return v;
  return { ...v, issues, status: issues.length ? v.status : (v.status === 'flagged' ? 'approved' : v.status) };
}

/**
 * The drafts still worth redoing: those with nothing published yet.
 *
 * A cover that has gone out is history — the profile already shows it, and
 * redoing it changes nothing anyone will see. What the clinic wants to look
 * like the profile is everything still to come: drafts with no post yet, and
 * drafts whose posts are scheduled or waiting. One published post on a draft
 * and it is left as it is.
 */
export function unpublishedOnly<T extends { id: string }>(drafts: readonly T[], posts: readonly { draft_id: string | null; status: string | null }[]): T[] {
  const published = new Set(posts.filter((p) => p.draft_id && String(p.status || '') === 'published').map((p) => String(p.draft_id)));
  return drafts.filter((d) => !published.has(d.id));
}

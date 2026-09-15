// web/lib/attach-plan.ts
// "Attach videos to rows N–M": what to do with each row so that every draft in
// the range carries its video.
//
// Three mechanisms already exist and this chooses between them per row:
//   attach  — the row has posts and at least one is waiting for its video:
//             the PENDING chip's action, per post (POST /api/posts attach_video).
//   queue   — the row has no posts and its copy is written: send the copy as
//             it is, with the video (POST /api/videos/queue).
//   prepare — the row has no posts and no copy: write the copy and queue it
//             with the video (the existing Prepare path).
//   done    — the row has posts and every one already carries the video.
//   no_video — nothing to attach.
//
// Pure and import-free: the test runner strips types and runs this directly.

export type AttachAction = 'attach' | 'queue' | 'prepare' | 'done' | 'no_video';

/** The slice of a Video Library row this needs. */
export type AttachRow = {
  /** The link Prepare would use; '' when the row has no video. */
  link: string;
  copy: string;
};

/** The slice of a publishing-list post this needs. */
export type PostLike = {
  id: string;
  videoPending?: boolean | null;
};

export function attachPlanFor(row: AttachRow, posts: readonly PostLike[] | null | undefined): AttachAction {
  if (!String(row.link || '').trim()) return 'no_video';
  const list = (posts || []).filter((p) => p && String(p.id || ''));
  if (list.length) return list.some((p) => p.videoPending === true) ? 'attach' : 'done';
  return String(row.copy || '').trim() ? 'queue' : 'prepare';
}

/** The posts of a row that still need the video — the ones `attach` acts on. */
export function pendingPosts<T extends PostLike>(posts: readonly T[] | null | undefined): T[] {
  return (posts || []).filter((p) => p && String(p.id || '') && p.videoPending === true);
}

/** Group a publishing list by the sheet row each post came from. */
export function postsByRow<T extends PostLike & { source?: { tab?: string | null; row?: number | null } | null }>(
  posts: readonly T[] | null | undefined,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const p of posts || []) {
    const tab = String(p?.source?.tab || '').trim();
    const row = p?.source?.row;
    if (!tab || typeof row !== 'number' || !Number.isFinite(row)) continue;
    const key = tab + ':' + Math.floor(row);
    const list = out.get(key) || [];
    list.push(p);
    out.set(key, list);
  }
  return out;
}

// web/lib/video-board.ts
// The "Prepared videos" board: one line per VIDEO, with its drafts.
//
// THE PROBLEM. A video becomes up to three Metricool posts (YouTube, LinkedIn,
// TikTok), and the dashboard has always shown and approved them one POST at a
// time: three buttons, three confirmation dialogs, per video. The Prepare
// panel showed one result at a time. Somebody who prepared ten videos and got
// the go-ahead for all of them had thirty clicks in front of them.
//
// This groups a publishing list by the video each post came from, decides
// which of them can be approved right now, and counts what a batch approval
// would do — so a screen can show "these N videos, these M posts" and act on
// them in one press through the SAME approve route as before, one call per
// post, with every gate still in place.
//
// Pure and import-free (the status rule is passed in): the test runner strips
// types and runs this file directly.
import type { PostSource } from './sheet-link';

export type BoardPost = {
  id: string;
  status?: unknown;
  providers?: readonly string[] | null;
  publication_date?: string | null;
  text?: string | null;
  draft_id?: string | null;
  videoPending?: boolean | null;
  source?: { tab?: string | null; row?: number | null; gid?: number | null; title?: string | null } | null;
};

export type VideoGroup<T extends BoardPost = BoardPost> = {
  /** Stable key: the draft when there is one, else the sheet row, else the post. */
  key: string;
  draftId: string | null;
  source: PostSource | null;
  title: string;
  /** The copy, from the first post — what the person reads before approving. */
  text: string;
  posts: T[];
  /** At least one draft is still waiting for its video: approving is blocked. */
  pendingVideo: boolean;
  /** Posts a person can approve right now. */
  awaiting: T[];
  approved: number;
  /** Earliest publication instant among the posts, for ordering. */
  firstAt: number;
};

function firstLine(text: string): string {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
}

/**
 * Group posts by video.
 *
 * @param isAwaiting  the app's own "waiting for approval" rule (lib/post-mode.ts)
 * @param isApproved  the app's own "approved / scheduled" rule
 */
export function groupPostsByVideo<T extends BoardPost>(
  posts: readonly T[] | null | undefined,
  isAwaiting: (status: unknown) => boolean,
  isApproved: (status: unknown) => boolean,
): VideoGroup<T>[] {
  const map = new Map<string, VideoGroup<T>>();
  for (const p of posts || []) {
    if (!p || !String(p.id || '')) continue;
    const draftId = p.draft_id ? String(p.draft_id) : null;
    const src = p.source && p.source.tab && typeof p.source.row === 'number'
      ? { spreadsheetId: '', tab: String(p.source.tab), row: p.source.row, gid: typeof p.source.gid === 'number' ? p.source.gid : null, title: p.source.title ?? null }
      : null;
    const key = draftId ? 'draft:' + draftId : src ? 'row:' + src.tab + ':' + src.row : 'post:' + p.id;
    let g = map.get(key);
    if (!g) {
      g = {
        key, draftId, source: src,
        title: String(src?.title || '').trim() || firstLine(String(p.text || '')) || 'Untitled video',
        text: String(p.text || ''),
        posts: [], pendingVideo: false, awaiting: [], approved: 0, firstAt: Number.POSITIVE_INFINITY,
      };
      map.set(key, g);
    }
    g.posts.push(p);
    if (p.videoPending === true) g.pendingVideo = true;
    if (isAwaiting(p.status)) g.awaiting.push(p);
    if (isApproved(p.status)) g.approved++;
    const at = Date.parse(String(p.publication_date || ''));
    if (Number.isFinite(at) && at < g.firstAt) g.firstAt = at;
  }
  return [...map.values()].sort((a, b) => a.firstAt - b.firstAt);
}

/** The groups a person can approve now: something waiting, and the video in place. */
export function approvableGroups<T extends BoardPost>(groups: readonly VideoGroup<T>[]): VideoGroup<T>[] {
  return groups.filter((g) => g.awaiting.length > 0 && !g.pendingVideo);
}

/** The posts a batch approval of `selected` keys would send — pending-video groups are left out. */
export function postsToApprove<T extends BoardPost>(groups: readonly VideoGroup<T>[], selected: ReadonlySet<string>): T[] {
  return approvableGroups(groups).filter((g) => selected.has(g.key)).flatMap((g) => g.awaiting);
}

/** The sentence the confirmation shows. */
export function approvalSummary(videos: number, posts: number, now: boolean): string {
  const v = videos + ' video' + (videos === 1 ? '' : 's');
  const p = posts + ' post' + (posts === 1 ? '' : 's');
  return now
    ? 'Publish ' + v + ' now (' + p + ')? They go out in the next couple of minutes. Metricool does the publishing.'
    : 'Approve ' + v + ' (' + p + ')? Each goes out at its scheduled time. Metricool does the publishing.';
}

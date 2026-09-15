// web/lib/post-source.ts
// Which sheet row a queued post came from — for EVERY post the app can tell.
//
// GET /api/posts used to answer this with one join: video_runs by draft_id.
// A post got its row chip only when its draft happened to be the one a
// sweep or a Prepare run had recorded. A post sent from the composer (no
// draft), one prepared from a pasted link, a batch post, or two rows that
// share one draft (last run won) all came out with no row — though the app
// knew the video, and the register already held tab, row and gid for every
// video in the sheet.
//
// This is the pure half: given what the route has already read, resolve a
// row per post in four tiers, first hit wins. No guessing: a post with no
// video and no run keeps no row rather than a wrong one.
//
// No `@/` imports, so `node --experimental-strip-types --test` runs it.
import { parseDriveFileId } from './drive-url.ts';
import { registerSource, type RegisterLike } from './register-source.ts';
import { videoSourceOf, type PackLike } from './video-required.ts';
import type { PostSource } from './sheet-link.ts';

export type PostLike = {
  id: unknown;
  draft_id?: unknown;
  media_drive_file_id?: unknown;
};

export type RunLike = {
  draft_id?: unknown;
  spreadsheet_id?: unknown;
  tab?: unknown;
  row_number?: unknown;
  video_title?: unknown;
  video_link?: unknown;
  updated_at?: unknown;
};

export type RegisterEntryLike = RegisterLike & {
  link?: unknown;
  event?: unknown;
  created_at?: unknown;
};

export type ResolveInput = {
  posts: readonly PostLike[];
  /** draft id → the draft's pack (as GET /api/posts already reads). */
  packs: Record<string, PackLike | null | undefined>;
  /** The user's video_runs, any order. */
  runs: readonly RunLike[];
  /** video_transcripts: public copy file id → source video id. */
  copyToVideo: Record<string, string>;
  /** video_register lines, any order. */
  register: readonly RegisterEntryLike[];
};

/** The video id a link or id string names: a Drive file id, else the trimmed string itself. */
export function videoIdOf(linkOrId: unknown): string | null {
  const s = String(linkOrId ?? '').trim();
  if (!s) return null;
  return parseDriveFileId(s) || s;
}

/** The source video id a draft pack points at, if any. */
export function packVideoId(pack: PackLike | null | undefined): string | null {
  const p = pack as { videoId?: unknown } | null | undefined;
  return videoIdOf(p?.videoId) || videoIdOf(videoSourceOf(pack ?? null));
}

function time(v: unknown): number {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
}

function sourceOfRun(r: RunLike): PostSource | null {
  const spreadsheetId = String(r.spreadsheet_id ?? '').trim();
  if (!spreadsheetId) return null;
  const row = typeof r.row_number === 'number' && Number.isFinite(r.row_number) ? Math.floor(r.row_number) : null;
  return {
    spreadsheetId,
    tab: String(r.tab ?? ''),
    row: row != null && row >= 2 ? row : null,
    gid: null,
    title: r.video_title == null ? null : String(r.video_title),
  };
}

/**
 * Resolve a sheet row for each post.
 *
 *  1. a run recorded for the post's draft (the newest, when rows share one);
 *  2. a run for the post's source video (from the draft's pack);
 *  3. the same, with the source video found through the post's public copy;
 *  4. a register line for that video that names a row (the newest).
 */
export function resolvePostSources(input: ResolveInput): Map<string, PostSource> {
  const runsNewestFirst = [...input.runs].sort((a, b) => time(b.updated_at) - time(a.updated_at));
  const runByDraft = new Map<string, RunLike>();
  const runByVideo = new Map<string, RunLike>();
  for (const r of runsNewestFirst) {
    const d = String(r.draft_id ?? '').trim();
    if (d && !runByDraft.has(d)) runByDraft.set(d, r);
    const v = videoIdOf(r.video_link);
    if (v && !runByVideo.has(v)) runByVideo.set(v, r);
  }

  const registerNewestFirst = [...input.register].sort((a, b) => time(b.created_at) - time(a.created_at));
  const registerByVideo = new Map<string, PostSource>();
  for (const e of registerNewestFirst) {
    const v = videoIdOf(e.link);
    if (!v || registerByVideo.has(v)) continue;
    const src = registerSource(e);
    // Only a line that names a row can identify one.
    if (src && src.row != null) registerByVideo.set(v, src);
  }

  const out = new Map<string, PostSource>();
  for (const p of input.posts) {
    const id = String(p.id ?? '');
    if (!id) continue;
    const draftId = String(p.draft_id ?? '').trim();

    const byDraft = draftId ? runByDraft.get(draftId) : undefined;
    const fromDraft = byDraft ? sourceOfRun(byDraft) : null;
    if (fromDraft) { out.set(id, fromDraft); continue; }

    const videoIds: string[] = [];
    const fromPack = draftId ? packVideoId(input.packs[draftId]) : null;
    if (fromPack) videoIds.push(fromPack);
    const copyId = String(p.media_drive_file_id ?? '').trim();
    const fromCopy = copyId ? String(input.copyToVideo[copyId] ?? '').trim() : '';
    if (fromCopy && !videoIds.includes(fromCopy)) videoIds.push(fromCopy);

    let found: PostSource | null = null;
    for (const v of videoIds) {
      const run = runByVideo.get(v);
      const src = run ? sourceOfRun(run) : null;
      if (src) { found = src; break; }
    }
    if (!found) {
      for (const v of videoIds) {
        const src = registerByVideo.get(v);
        if (src) { found = src; break; }
      }
    }
    if (found) out.set(id, found);
  }
  return out;
}

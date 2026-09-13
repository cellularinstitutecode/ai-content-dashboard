// web/lib/video-required.ts
// The rule: a post whose copy was transcribed from a video must carry that
// video. If it has none it is PENDING, and it cannot be approved.
//
// WHY THIS IS AWKWARD TO ASK. There is no column anywhere meaning "this came
// from a video" — not on `posts`, not on `drafts`. `format: 'video'` is never
// persisted at all; it exists only as an in-request argument. The one real
// marker is the draft's own pack: `prepareVideo` stamps `kind: 'video'` on it
// (lib/video-prepare.ts) and the Opus clip path stamps `kind: 'clip'`. Both are
// video. Reaching them means `posts.draft_id` → `drafts.pack`, which is a read
// /api/posts already performs to recover the hero image — so the rule costs no
// new column and no migration.
//
// Pure and import-free: the test runner strips types and runs this file
// directly, and after two audits found every defect in code that could not be
// tested, the wording and the decision both live somewhere they can be.

/** The pack shapes that mean "this copy came from a video". */
export const VIDEO_PACK_KINDS = ['video', 'clip'] as const;

/**
 * A draft's `pack`, as it actually arrives: arbitrary JSONB.
 *
 * Not narrowed to the fields this module reads — a real pack carries the
 * per-network copy and whatever else the generator stamped on it, and a type
 * that lists only `kind` and `sourceUrl` rejects every genuine pack while
 * accepting `{}`.
 */
export type PackLike = Record<string, unknown> | null | undefined;

/**
 * Was this post's copy derived from a video?
 *
 * Deliberately narrow. A post is video-derived when its draft says so, and not
 * because of its network: a manually written TikTok post is not video-derived
 * (it is caught by the separate needs-media rule), and a LinkedIn post written
 * from a transcript IS, even though LinkedIn takes text happily.
 */
export function videoDerived(pack: PackLike): boolean {
  const kind = String((pack as { kind?: unknown } | null)?.kind ?? '').toLowerCase();
  return (VIDEO_PACK_KINDS as readonly string[]).includes(kind);
}

/** The source video's link, for the one-click attach. */
export function videoSourceOf(pack: PackLike): string | null {
  const url = String((pack as { sourceUrl?: unknown } | null)?.sourceUrl ?? '').trim();
  return url || null;
}

export type VideoVerdict = {
  /** True when this post is waiting on its video and must not be approved. */
  pending: boolean;
  /** One sentence for a person. Empty when nothing is wrong. */
  reason: string;
  /** Where to fetch the video from, when there is somewhere. */
  sourceUrl: string | null;
};

/**
 * Can this post go out?
 *
 * @param pack the post's draft pack, or null when the post has no draft.
 * @param hasVideo whether the post resolves to THE VIDEO.
 *
 * `hasVideo`, not `hasMedia`, and the distinction is the whole rule. A picture
 * is an attachment; it is not the video this copy was written from, and a gate
 * that accepts any media would wave through exactly the post the rule exists to
 * stop — a transcript-derived caption published over a generated hero image.
 * In practice the caller answers this from `posts.media_drive_file_id`, which
 * only ever holds the world-readable copy of a video (lib/video-publish.ts
 * writes it, and so does the attach button); no image path touches that column.
 */
export function videoVerdict(pack: PackLike, hasVideo: boolean): VideoVerdict {
  if (!videoDerived(pack)) return { pending: false, reason: '', sourceUrl: null };
  if (hasVideo) return { pending: false, reason: '', sourceUrl: videoSourceOf(pack) };

  const sourceUrl = videoSourceOf(pack);
  return {
    pending: true,
    sourceUrl,
    reason: sourceUrl
      ? 'This copy was written from a video, so it cannot go out without one. Attach the video to approve it.'
      : 'This copy was written from a video, so it cannot go out without one — and the draft no longer records which video it came from. Re-prepare the row from the Video Library.',
  };
}

/** The chip. Short, because it sits in a status slot beside a date. */
export function pendingLabel(): string {
  return 'Pending video';
}

/**
 * What the refusal says when somebody presses Approve anyway.
 *
 * Distinct from `reason` on purpose: the chip explains a state, this explains a
 * refusal, and a refusal that does not say what to do next is just a wall.
 */
export function pendingRefusal(v: VideoVerdict): string {
  return v.sourceUrl
    ? 'Not approved: this post was written from a video and has none attached. Press "Pending video" on the post to attach it, then approve.'
    : 'Not approved: this post was written from a video and has none attached, and the draft no longer records which video. Re-prepare that row from the Video Library.';
}

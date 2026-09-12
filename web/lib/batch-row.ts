// web/lib/batch-row.ts
// The `posts` row a queued batch item leaves behind.
//
// Pulled out of lib/batch-draft.ts so it can be tested. That file imports
// `server-only`, so nothing in it could run under `node --test` — and the row it
// built shipped with two defects that a single assertion would have caught: it
// wrote a wall-clock string into a timestamptz column (putting every batch draft
// five hours out on the dashboard calendar) and it linked neither the draft nor
// the Drive file, so the first edit stripped the post's video.
//
// No imports: the test runner strips types and runs this file directly.

export type PostRow = {
  user_id: string;
  providers: string[];
  text: string;
  /** ISO-8601 with an offset. The column is timestamptz. */
  publication_date: string;
  metricool_post_id: string | null;
  status: string;
  draft_id?: string;
  media_drive_file_id?: string;
};

/**
 * Build the row.
 *
 * @param instant the ABSOLUTE instant, from normalizePublishAt().instant — never
 *   the wall-clock half. Postgres reads a bare "2026-10-01T09:00" as UTC, so a
 *   wall-clock string is stored as a different moment than the one Metricool was
 *   given, and the two disagree with nothing on screen saying which is right.
 */
export function postRowFor(input: {
  userId: string;
  provider: string;
  text: string;
  instant: string;
  metricoolId?: string | null;
  draftId?: string | null;
  mediaFileId?: string | null;
}): PostRow {
  return {
    user_id: input.userId,
    providers: [input.provider],
    text: input.text,
    publication_date: input.instant,
    metricool_post_id: input.metricoolId ?? null,
    // Never 'scheduled'. Metricool says that about a post it is HOLDING for
    // review, and storing its word made our rows claim an approval nobody gave.
    status: 'pending_review',
    // Both are what /api/posts rebuilds a post's media from on a later edit,
    // under an explicit "a replace REPLACES" contract — a row with neither loses
    // its video the first time anybody nudges the time on the calendar.
    ...(input.draftId ? { draft_id: input.draftId } : {}),
    ...(input.mediaFileId ? { media_drive_file_id: input.mediaFileId } : {}),
  };
}

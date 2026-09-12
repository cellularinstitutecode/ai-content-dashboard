// web/lib/batch-row.ts
// The `posts` row a queued batch item leaves behind.
//
// Pulled out of lib/batch-draft.ts so it can be tested. That file imports
// `server-only`, so nothing in it could run under `node --test` — and the row it
// built shipped with two defects that a single assertion would have caught: it
// wrote a wall-clock string into a timestamptz column (putting every batch draft
// five hours out on the dashboard calendar) and it did not link the draft it had
// just created.
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
    // draft_id is what /api/posts rebuilds a post's media from on a later edit,
    // under an explicit "a replace REPLACES" contract.
    //
    // media_drive_file_id is deliberately NOT set here, and the reason is worth
    // stating because writing it looked like the obvious fix and is dangerous.
    // That column means "the id of the world-readable COPY this app made", which
    // is how lib/video-autopilot.ts fills it — and /api/posts DELETE hands it
    // straight to deleteDriveFile, whose own contract is "only ever called with
    // an id the app RECORDED when it made the file". The only id available here
    // is parsed out of a URL the model supplied, so a link to a publicly-shared
    // ORIGINAL would put the clinic's source footage on the delete path. It also
    // would not work: /api/posts resolves the column through cachedPublicCopy,
    // which is keyed by the SOURCE video id, not the copy id.
    ...(input.draftId ? { draft_id: input.draftId } : {}),
  };
}

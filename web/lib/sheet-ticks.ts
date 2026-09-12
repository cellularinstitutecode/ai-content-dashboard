// web/lib/sheet-ticks.ts
// Reading the network checkboxes in the video sheet.
//
// Columns H–N (YOUTUBE, LINKEDIN, TIKTOK, X, FACEBOOK, INSTAGRAM, EMAIL) are
// the clinic's own instruction for where a video goes. Two values look alike
// and mean opposite things:
//
//   a tick   — "post this here"       an instruction, still to be carried out
//   a link   — "this is already up"   a record of something already done
//
// The link case used to count as the strongest possible yes, which queued a
// second draft of a video already live on the channel. The better the sheet was
// kept, the more duplicates it produced.
//
// Pure, because lib/google-sources.ts imports server-only and cannot be
// unit-tested, and this rule decides what gets published.

/** What counts as "yes" in a hand-kept column: ticks, x, TRUE — never FALSE. */
const YES = /^(x|✓|✔|yes|si|sí|true|posted|done)$/i;

/** Does this cell hold a published URL rather than an instruction? */
export function isPublishedLink(value: string | null | undefined): boolean {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/**
 * Does this cell say "post here"?
 *
 * Google's checkbox writes the literal strings TRUE and FALSE, so an
 * is-it-non-empty test marked every unticked column as a destination — a
 * YouTube-only video went out as LinkedIn and Email too.
 */
export function isTicked(value: string | null | undefined): boolean {
  const v = String(value || '').trim();
  return YES.test(v) && !isPublishedLink(v);
}

/** The networks a row is asking for, given its columns. */
export function tickedNetworks(
  columns: readonly [string, string][],
  read: (column: string) => string,
): string[] {
  return columns.filter(([col]) => isTicked(read(col))).map(([, network]) => network);
}

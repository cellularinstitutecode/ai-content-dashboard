// web/lib/reseed.ts
// Whether a second keyword lookup — seeded from the transcript rather than the
// filename — is allowed to replace the first.
//
// The bug this ends, in full:
//
//   if (hasSemrushData(retry.stamp) && (!hasSemrushData(brief.stamp) || grounded(retry) > grounded(brief)))
//
// Read the second half. When the FIRST brief had no Semrush data,
// `!hasSemrushData(brief.stamp)` is true, the `||` short-circuits, and
// `grounded(retry)` is never evaluated at all. GROUNDING_FLOOR — the whole
// point of measuring grounding — does not apply on that branch.
//
// That branch is the common one, not the edge case. A filename like
// "Reel_RyallOxygenCircuit_Rodrigo" yields the subject "Oxygen Circuit", which
// is what the clinic calls the protocol and not what anyone searches, so
// Semrush returns nothing and the first brief is empty by construction. The
// re-seed then takes the transcript's most frequent bigram — "red light", said
// a few times while describing the circuit — gets real data back for it, and is
// accepted unconditionally. The caption led on red light therapy.
//
// So the fix is a floor, not a comparison: better than nothing is not the test,
// being about the video is the test. An off-topic brief is worse than no brief,
// because no brief leaves the transcript to write the copy on its own.
//
// Pure and import-free: lib/video-prepare.ts pulls in Supabase, Drive, the AI
// client and ffmpeg, so this rule could never be tested where it lived.

export type ReseedInput = {
  /** Did this brief come back with real Semrush rows? */
  hasData: boolean;
  /** Share of the brief's keyword vocabulary the speaker actually uses, 0-1. */
  grounding: number;
};

export type ReseedDecision = {
  accept: boolean;
  /** Why — for logging, and so the tests assert the reason, not just the boolean. */
  reason: 'no-data' | 'not-grounded' | 'not-better' | 'ok';
};

/**
 * Replace the filename-seeded brief with the transcript-seeded one?
 *
 * Three gates, all of which must pass:
 *
 *   1. the retry actually returned data — an empty brief replaces nothing;
 *   2. the retry clears `floor` ABSOLUTELY — this is the gate that was missing,
 *      and it applies whether or not the first brief had data;
 *   3. it is an improvement — either the first brief had nothing, or the retry
 *      is better grounded than it.
 *
 * Order matters for the reason code: a retry that is both ungrounded and no
 * better should say it is ungrounded, since that is the actionable half.
 */
export function shouldReseed(first: ReseedInput, retry: ReseedInput, floor: number): ReseedDecision {
  if (!retry.hasData) return { accept: false, reason: 'no-data' };
  if (retry.grounding < floor) return { accept: false, reason: 'not-grounded' };
  if (first.hasData && retry.grounding <= first.grounding) return { accept: false, reason: 'not-better' };
  return { accept: true, reason: 'ok' };
}

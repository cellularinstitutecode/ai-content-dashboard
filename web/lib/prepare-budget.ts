// web/lib/prepare-budget.ts
// How much of the function's clock each step of a Prepare is allowed to spend.
//
// The whole point is that the decision is made BEFORE the expensive step, not
// after it. Until now `prepareVideo` read the clock exactly once, and it did so
// after the download, the audio extraction and the transcription had already
// run — so on a 149 MB reel the platform killed the request mid-download and
// the check never executed at all. A budget that is only consulted once the
// money is spent is not a budget.
//
// No imports, deliberately: the test runner strips types and runs this file
// directly, and a single `@/`-aliased import would take it out of reach.

/** What the steps AFTER the download still need before the request is worth starting. */
export const RESERVE_MS = {
  /** ffmpeg pulling a 16 kHz mono track out of the container. */
  extract: 25_000,
  /** Whisper on that track. */
  transcribe: 60_000,
  /**
   * The FLOOR kept back for Semrush + the writer + the sheet + the Metricool
   * draft — what must remain before the transcription step is allowed to eat
   * the rest of the clock.
   *
   * Not the same question as "is there enough left to press on", which is
   * COMFORTABLE_COPY_MS below. Raising this one to answer that question starves
   * transcribeBudgetMs, and the run then dies before the transcript is banked —
   * which is strictly worse than dying after it, because nothing is kept.
   */
  copy: 60_000,
} as const;

/**
 * Enough time to write the copy WITHOUT hurrying.
 *
 * The number that decides between two paths that both already exist: press on
 * in this request, or bank the transcript, answer 202 'transcript_ready', and
 * let lib/prepare-request.ts ask again — where the second request begins with a
 * whole fresh clock and the transcript comes back from cache in about a second.
 *
 * At 60 seconds the pipeline pressed on with a minute. That is the wrong choice
 * whenever the download was slow, because handing off costs one extra round
 * trip and buys FIVE TIMES the time. It only looked right because a normal
 * 76-283 MB reel downloads in seconds and never comes close to the threshold.
 *
 * Deliberately larger than RESERVE_MS.copy rather than replacing it: the floor
 * governs how much transcription may spend, this governs whether writing starts
 * here or next door. One number cannot mean both.
 */
export const COMFORTABLE_COPY_MS = 150_000;

/** Time left on the function's clock. Negative once it has been overrun. */
export function remainingMs(startedAt: number, totalMs: number, now: number): number {
  return totalMs - (now - startedAt);
}

/**
 * How long the download may take.
 *
 * Everything that has to happen after it is subtracted first, so a download
 * that would leave no room to transcribe is never started. Zero or less means
 * "do not start" — and the caller says so with the number of seconds it had,
 * which is a refusal somebody can act on, unlike a kill that says nothing.
 */
export function downloadBudgetMs(remaining: number): number {
  return remaining - (RESERVE_MS.extract + RESERVE_MS.transcribe);
}

/**
 * How long the transcriber may take, given what the download actually cost.
 *
 * Capped at the nominal reserve rather than handed the whole remainder: a
 * transcription that runs far past 60 seconds is stuck, and letting it eat the
 * copy's share turns one slow video into a request that returns nothing.
 */
/**
 * The budget for reading audio straight off a URL.
 *
 * downloadBudgetMs holds back time for BOTH the transfer and a separate
 * extraction step, because the disk path does them one after the other. The
 * streaming path does them in the same ffmpeg process — the bytes are decoded
 * as they arrive — so reserving for a second step that never happens takes 25
 * seconds off the one path that needs every second it can get. It is only ever
 * used by files too big to stage, which are by definition the slow ones.
 */
export function streamExtractBudgetMs(remaining: number): number {
  return remaining - RESERVE_MS.transcribe;
}

export function transcribeBudgetMs(remaining: number): number {
  const usable = remaining - RESERVE_MS.copy;
  return Math.max(0, Math.min(RESERVE_MS.transcribe, usable));
}

/**
 * Is there enough left to write the copy, or should this stop with the
 * transcript banked?
 *
 * The transcript is the expensive half. Once it is stored, stopping is a
 * finished half rather than a failure — but only if the stop happens before
 * the generation starts, not in the middle of it.
 */
export function canWriteCopy(remaining: number): boolean {
  return remaining >= COMFORTABLE_COPY_MS;
}

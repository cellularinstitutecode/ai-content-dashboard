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
  /** Semrush + the writer + the sheet + the Metricool draft. */
  copy: 60_000,
} as const;

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
  return remaining >= RESERVE_MS.copy;
}

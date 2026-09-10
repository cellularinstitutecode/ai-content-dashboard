// web/lib/ai-attempts.ts
// How many tries the writer gets, and how long each may take.
//
// lib/ai.ts asked for a fixed three attempts of thirty seconds. Against the
// prepare pipeline's clock that is a promise it cannot keep: RESERVE_MS.copy
// holds back SIXTY seconds for "Semrush + the writer + the sheet + the
// Metricool draft", and three thirty-second attempts plus their backoff is
// about ninety-two before any of the rest happens.
//
// So the guard that exists precisely to stop a request "marching into Semrush
// and the writer and dying there" was letting it, by a factor of more than two.
// It never showed on a normal reel: 76-283 MB downloads in seconds, the writer
// starts with minutes in hand, and thirty seconds is plenty. It shows the
// moment the download is slow — a 1722 MB video read straight off Drive — and
// then the whole thing ends on "The writer did not answer just now", with the
// transcript paid for and nothing to show.
//
// The fix is not a bigger constant. It is that the retry budget belongs to the
// clock rather than to a number chosen without one: with sixty seconds left,
// one fifty-seven-second attempt is strictly better than three nineteen-second
// attempts, because a nineteen-second ceiling simply fails a call that needs
// twenty-five and then fails it twice more.
//
// No imports: the test runner strips types and runs this file directly.

/** What one attempt should get when there is room to choose. */
export const TARGET_ATTEMPT_MS = 30_000;
/** Never more than this many, however much time there is. */
export const MAX_ATTEMPTS = 3;
/**
 * Held back from the attempts themselves.
 *
 * The backoff between retries, and the parsing, compliance and Crossref work
 * that follows the last one. Without it a plan that exactly fills the budget
 * leaves nothing for the steps that turn a response into a draft.
 */
export const SLACK_MS = 5_000;

export type AttemptPlan = {
  /** Passed to fetchWithRetry as `retries` + 1 total tries. */
  attempts: number;
  /** The per-attempt abort deadline. */
  timeoutMs: number;
};

/**
 * Fit the writer to the time actually left.
 *
 * Fewer, longer attempts when the clock is short — the opposite of what a fixed
 * retry count does, and the reason this exists. Three tries are only worth
 * having when each can still be long enough to succeed.
 *
 * A budget of zero or less still yields one attempt: the caller's own guard
 * (canWriteCopy) decides whether to start at all, and returning "no attempts"
 * here would turn a tight request into a silent no-op instead of a try that
 * either works or says why it did not.
 */
export function attemptPlan(remainingMs: number, target = TARGET_ATTEMPT_MS): AttemptPlan {
  const usable = Math.floor(remainingMs) - SLACK_MS;
  if (!Number.isFinite(usable) || usable <= 0) return { attempts: 1, timeoutMs: target };
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(usable / target)));
  return { attempts, timeoutMs: Math.floor(usable / attempts) };
}

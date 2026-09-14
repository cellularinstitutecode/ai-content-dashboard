// web/lib/run-failure.ts
// Why an Autopilot run is sitting under "Needs attention".
//
// THE BUG THIS EXISTS FOR. app/AutopilotQueue.tsx rendered a hardcoded sentence
// for every failed run:
//
//     "… — repeated errors; check API keys, then retry."
//
// No branch, no mapper, no lookup — the only dynamic parts were the template
// name and the date. Three unrelated things reach state 'failed', and exactly
// one of them is ever plausibly an API key:
//
//   expireStaleRuns   the slot passed before the post was ready. Nothing
//                     errored. Nothing is wrong with any key.
//   the step handler  something threw, and the engine WROTE DOWN WHAT.
//   a platform kill   the attempt is claimed before the work, so a killed
//                     lambda leaves attempts spent and no 'error' line at all.
//
// Meanwhile the engine records the real cause per run in `template_runs.log`,
// the API already selects it, and it already travels to the browser on every
// poll — where the component dropped it one line before display. So the screen
// replaced a recorded fact with a guess, and the guess was wrong at least a
// third of the time.
//
// Pure and import-free: the test runner strips types and runs this file
// directly, and after three audits found every defect in code that could not be
// tested, the wording and the decision both live somewhere they can be.

/** One entry of `template_runs.log`, as lib/autopilot.ts's logLine writes it. */
export type RunLogEntry = { at: string; step: string; note: string };

/**
 * The log as it actually arrives: JSONB, so anything at all.
 *
 * Not typed as `RunLogEntry[]` — a column that has never been written reads
 * back as null, and a hand-edited row can hold anything. Every reader below
 * narrows defensively rather than trusting the shape.
 */
export type RunLogLike = unknown;

/**
 * What kind of failure this is. The whole point of the module: these four are
 * told apart by evidence, and 'unknown' is a real answer rather than a default
 * that gets dressed up as a specific cause.
 */
export type FailureKind = 'expired' | 'error' | 'stalled' | 'unknown';

/** The step name expireStaleRuns stamps (lib/autopilot.ts). */
export const EXPIRED_STEP = 'expired';
/** The step name the advancer's catch stamps. */
export const ERROR_STEP = 'error';

/** Narrow the JSONB column to the entries we can actually read. */
export function runLog(log: RunLogLike): RunLogEntry[] {
  if (!Array.isArray(log)) return [];
  const out: RunLogEntry[] = [];
  for (const raw of log) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const step = typeof e.step === 'string' ? e.step : '';
    const note = typeof e.note === 'string' ? e.note : '';
    const at = typeof e.at === 'string' ? e.at : '';
    if (!step && !note) continue;
    out.push({ at, step, note });
  }
  return out;
}

/**
 * The last thing that happened, whatever it was.
 *
 * `logLine` appends, so the tail is the most recent entry. Returns null for an
 * empty or unreadable log — which the caller must render as "we don't know",
 * never as a cause.
 */
export function lastEntry(log: RunLogLike): RunLogEntry | null {
  const entries = runLog(log);
  return entries.length ? entries[entries.length - 1] : null;
}

/**
 * The last entry that explains a FAILURE, as opposed to the last entry at all.
 *
 * These are not the same thing and the difference matters. A run can be expired
 * by the sweeper after it had already logged an 'error' on an earlier tick; the
 * tail is then 'expired' while the useful sentence is further back. So the
 * expiry is reported as the kind (it is what actually ended the run) and the
 * error note is still available to show underneath.
 */
export function lastFailure(log: RunLogLike): RunLogEntry | null {
  const entries = runLog(log);
  for (let i = entries.length - 1; i >= 0; i--) {
    const step = entries[i].step;
    if (step === ERROR_STEP || step === EXPIRED_STEP) return entries[i];
  }
  return null;
}

/** The most recent thrown message, if this run ever recorded one. */
export function lastErrorNote(log: RunLogLike): string | null {
  const entries = runLog(log);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].step === ERROR_STEP) return entries[i].note || null;
  }
  return null;
}

/**
 * Which of the three failures this is.
 *
 * @param log the run's `log` column.
 * @param attempts the run's `attempts` column, or null when unknown.
 * @param maxAttempts MAX_ATTEMPTS, passed in rather than imported so this file
 *        stays import-free and the caller cannot drift from the engine's value.
 *
 * 'stalled' is the case nothing else in the app can see: the advancer claims
 * the attempt BEFORE doing the work, so a lambda killed mid-step leaves
 * attempts spent with no 'error' line ever written. The scheduled query then
 * filters `.lt('attempts', MAX_ATTEMPTS)` and the run is excluded from every
 * future tick — invisible until the sweeper retires it and calls it an expiry.
 * Naming it is the only way a person can tell "your key is broken" from "the
 * platform dropped this one".
 */
export function failureKind(
  log: RunLogLike,
  attempts: number | null | undefined,
  maxAttempts: number,
): FailureKind {
  const failure = lastFailure(log);
  const spent = typeof attempts === 'number' && attempts >= maxAttempts;

  if (failure?.step === ERROR_STEP) return 'error';
  if (failure?.step === EXPIRED_STEP) {
    // Expired AND out of attempts with no error ever recorded: the platform
    // kill. The sweeper's note is true but it is not the reason.
    return spent && !lastErrorNote(log) ? 'stalled' : 'expired';
  }
  if (spent) return 'stalled';
  return 'unknown';
}

/** The headline on the card. Short — it sits beside a template name and a date. */
export function failureHeadline(kind: FailureKind): string {
  switch (kind) {
    case 'expired':
      return 'Missed its time';
    case 'error':
      return 'Stopped with an error';
    case 'stalled':
      return 'Stopped part-way';
    default:
      return 'Did not finish';
  }
}

/**
 * What to tell a person, and what to tell them to DO.
 *
 * The note is the engine's own sentence and is passed through as-is for the
 * error case — it is the most accurate thing anybody has, and paraphrasing it
 * is how the hardcoded string happened in the first place.
 */
export function failureAdvice(kind: FailureKind, note: string | null): string {
  switch (kind) {
    case 'expired':
      // Deliberately does NOT offer a retry. Retrying an expired run restarts
      // it from research and then hands Metricool a post dated in the past,
      // which Metricool accepts and then refuses when somebody opens it to
      // approve — a dead end that looks like progress. The next occurrence is
      // the real answer.
      return 'Its scheduled time passed before the draft was ready, so nothing was sent. ' +
        'Nothing is wrong with your keys. Retrying this one would only produce a post dated in the past — ' +
        'the next occurrence of this template runs on schedule.';
    case 'error':
      return note
        ? note
        : 'The engine recorded an error but not what it was. Press Retry, and if it stops again the Vercel logs will have the detail.';
    case 'stalled':
      return 'The engine started this one and was cut off before it finished — its attempts are used up but it never recorded a reason, ' +
        'which usually means the run was stopped by the platform rather than by a fault in your setup. Press Retry.';
    default:
      return 'This one did not finish and the engine did not record why. Press Retry — if it stops again, the reason will be recorded next time.';
  }
}

/**
 * Everything the card needs, in one call.
 *
 * @param log the run's `log` column.
 * @param attempts the run's `attempts` column.
 * @param maxAttempts the engine's MAX_ATTEMPTS.
 */
export function describeFailure(
  log: RunLogLike,
  attempts: number | null | undefined,
  maxAttempts: number,
): {
  kind: FailureKind;
  headline: string;
  advice: string;
  /** The step the run died at, when the log records one. */
  step: string | null;
  /** When it died, ISO, when the log records it. */
  at: string | null;
  /**
   * Is Retry worth offering?
   *
   * False for an expiry, and that is the whole reason this field exists: the
   * slot is in the past, so restarting the run just hands Metricool a post it
   * will refuse at approval time. Offering a button that cannot work is the
   * same class of mistake as the hardcoded sentence this module replaced.
   */
  retryable: boolean;
} {
  const kind = failureKind(log, attempts, maxAttempts);
  const failure = lastFailure(log);
  // For a stalled run the sweeper's 'expired' step is not where it died, and
  // saying so would be worse than saying nothing.
  const step = kind === 'stalled' ? null : failure?.step || null;
  return {
    kind,
    headline: failureHeadline(kind),
    advice: failureAdvice(kind, kind === 'error' ? lastErrorNote(log) : null),
    step,
    at: failure?.at || null,
    retryable: kind !== 'expired',
  };
}

/**
 * The log as a person should read it: newest first, and only the entries that
 * say something.
 *
 * Newest first because the question is always "what happened last"; the thirty
 * before it answer the second question, which is "was it always like this".
 */
export function historyForDisplay(log: RunLogLike): RunLogEntry[] {
  return runLog(log).slice().reverse();
}

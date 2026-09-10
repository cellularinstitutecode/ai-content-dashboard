// web/lib/failure-kind.ts
// Is this failure worth trying again?
//
// The sweep used to answer that question with one number for every kind of
// failure: three attempts and the row is retired, permanently and silently,
// with no code anywhere able to un-retire it (lib/video-autopilot.ts:157-163).
//
// So a row that timed out three times — the clock's fault, and the clock has
// since been fixed — was retired exactly as hard as a row whose copy named a
// person who is not in the video. One of those is fixed by trying again. The
// other is fixed by a human, and trying again just spends another
// transcription to reach the same refusal.
//
// Separating them is what makes an automatic retry honest: the failures that a
// retry actually fixes get more of them, and the failures it cannot fix stop
// early and say so instead of burning money on the way to silence.
//
// No imports, deliberately: the test runner strips types and runs this file
// directly, and a single `@/`-aliased import would take it out of reach.
// Staleness lives in lib/video-row.ts (`claimIsStale`) and is not repeated here.

export type FailureKind =
  /** Trying again genuinely helps. The work was sound; the conditions were not. */
  | 'transient'
  /** Trying again reaches the same refusal. A person has to do something. */
  | 'terminal'
  /** Something outside this row is broken. Retrying is pure waste until it is fixed. */
  | 'blocked';

/**
 * The clock, a flaky upstream, a writer that threw. Nothing about the video is
 * wrong — it simply did not get through this time.
 */
const TRANSIENT = new Set([
  'out_of_time',
  'transcript_ready',
  'generation_failed',
  'unreachable',
  'sheet_write_failed',
]);

/**
 * A person must act: paste the words, fix the link, or look at why the writer
 * put a name in the copy. Another transcription changes nothing.
 */
const TERMINAL = new Set([
  'no_transcript',
  'transcript_too_short',
  'invalid_url',
  'no_source',
  'not_media',
  'too_large',
  'empty',
  'named_a_person',
  'no_citation',
]);

/**
 * The transcript store is missing, so every attempt re-downloads the whole
 * video and dies in the same place. The fix is a migration, not a retry.
 */
const BLOCKED = new Set([
  'transcript_not_kept',
  'migration_pending',
]);

/**
 * An unrecognised code is treated as transient on purpose.
 *
 * The alternative — defaulting to terminal — means any code added later, or
 * any failure recorded before this file existed, silently stops being retried.
 * A wasted retry is cheaper than a row that quietly stops being worked on,
 * which is the exact failure this module was written to end.
 */
export function failureKind(code: string | null | undefined): FailureKind {
  const c = String(code || '').trim();
  if (!c) return 'transient';
  if (BLOCKED.has(c)) return 'blocked';
  if (TERMINAL.has(c)) return 'terminal';
  return 'transient';
}

/**
 * How many passes a row of this kind is worth.
 *
 * `transient` gets more than the old flat three, because those are the ones a
 * retry fixes. `terminal` gets one: the first attempt already produced the
 * refusal, and the second would produce it again at the cost of another
 * download and another transcription. `blocked` also gets one, and the row
 * waits for the migration rather than paying for the same discovery daily.
 */
export function maxAttemptsFor(kind: FailureKind): number {
  if (kind === 'transient') return 5;
  return 1;
}

/**
 * Should the sweep pick this row up again?
 *
 * A row that has never failed has no code and no attempts, and is always
 * eligible. Past the allowance for its kind, it waits for somebody — or for
 * the assistant's retry, which clears the count.
 */
export function mayRetry(code: string | null | undefined, attempts: number): boolean {
  return attempts < maxAttemptsFor(failureKind(code));
}

/**
 * What to tell a person about a row that has stopped, in their words.
 *
 * The sweep stores the failure's own sentence in `last_error`, which is
 * written for whoever pressed the button. This is the other half: why nothing
 * is happening NOW, which the stored sentence never says.
 */
export function whyStopped(code: string | null | undefined, attempts: number): string | null {
  if (mayRetry(code, attempts)) return null;
  const kind = failureKind(code);
  if (kind === 'blocked') {
    return 'Waiting on a database update — retrying would download the whole video again and stop in the same place.';
  }
  if (kind === 'terminal') {
    return 'This one needs you — trying again would reach the same answer.';
  }
  return 'Tried ' + attempts + ' times without getting through.';
}

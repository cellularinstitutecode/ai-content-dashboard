// Why an Autopilot run failed, told apart by evidence.
//
// The defect: one hardcoded sentence — "repeated errors; check API keys, then
// retry" — shown for every failed run, including runs where nothing errored and
// no key was involved. The rule these tests defend is that a cause is only ever
// reported when it was actually recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  runLog,
  lastEntry,
  lastFailure,
  lastErrorNote,
  failureKind,
  failureAdvice,
  describeFailure,
  historyForDisplay,
  EXPIRED_STEP,
  ERROR_STEP,
} from './run-failure.ts';

// MAX_ATTEMPTS as lib/planner-constants.ts defines it. Passed in everywhere so
// this file stays import-free; asserted against the real value in its own test
// at the bottom.
const MAX = 2;

const entry = (step: string, note: string, at = '2026-09-15T06:30:00.000Z') => ({ at, step, note });

const EXPIRED_NOTE = 'Its scheduled time passed before this post was ready, so nothing was sent.';

// --- reading the column ------------------------------------------------------

test('a log that was never written reads as empty, not as a cause', () => {
  for (const bad of [null, undefined, 0, '', 'nope', {}, NaN]) {
    assert.deepEqual(runLog(bad), [], JSON.stringify(bad) + ' was not read as empty');
    assert.equal(lastEntry(bad), null);
    assert.equal(lastFailure(bad), null);
  }
});

test('junk entries are skipped rather than rendered', () => {
  const log = [null, 'x', 42, {}, { step: 'research', note: 'Angle: defend' }];
  assert.equal(runLog(log).length, 1);
  assert.equal(runLog(log)[0].step, 'research');
});

test('a missing `at` does not discard an otherwise readable entry', () => {
  const log = [{ step: ERROR_STEP, note: 'anthropic 401: bad key' }];
  assert.equal(runLog(log).length, 1);
  assert.equal(runLog(log)[0].at, '');
});

// --- the three kinds ---------------------------------------------------------

test('an expiry is an expiry and must never be blamed on a key', () => {
  const log = [entry('research', 'Angle: defend → "stem cell knee"'), entry(EXPIRED_STEP, EXPIRED_NOTE)];
  assert.equal(failureKind(log, 1, MAX), 'expired');

  const advice = failureAdvice('expired', null);
  assert.match(advice, /scheduled time passed/i);
  assert.doesNotMatch(advice, /api key/i, 'an expiry was blamed on API keys');
  // And it says what happens instead of retrying, because Retry cannot help:
  // the slot is in the past, so a restarted run only produces a post Metricool
  // will refuse at approval time.
  assert.match(advice, /next occurrence/i);
  assert.equal(describeFailure(log, 1, MAX).retryable, false, 'Retry was offered on an expired run');
});

test('a recorded error is passed through verbatim, not paraphrased', () => {
  const raw = 'anthropic 401: {"error":{"message":"invalid x-api-key"}}';
  const log = [entry('research', 'Angle: defend'), entry(ERROR_STEP, raw)];
  assert.equal(failureKind(log, 2, MAX), 'error');
  // The engine's own words. Paraphrasing them is how the hardcoded string
  // happened; the raw message is the most accurate thing anyone has.
  assert.equal(describeFailure(log, 2, MAX).advice, raw);
  assert.equal(describeFailure(log, 2, MAX).step, ERROR_STEP);
});

test('attempts spent with no error ever recorded is a stall, not an expiry', () => {
  // The platform-kill case: the advancer claims the attempt BEFORE the work, so
  // a killed lambda spends attempts and never reaches its catch. The sweeper
  // later stamps 'expired', which is true but is not the reason.
  const log = [entry('research', 'Angle: defend'), entry(EXPIRED_STEP, EXPIRED_NOTE)];
  assert.equal(failureKind(log, MAX, MAX), 'stalled');
  const d = describeFailure(log, MAX, MAX);
  assert.match(d.advice, /cut off|stopped by the platform/i);
  assert.doesNotMatch(d.advice, /api key/i);
  // It did not die at 'expired' — that is just where the sweeper found it.
  assert.equal(d.step, null);
  // A stall IS worth retrying: nothing is known to be broken.
  assert.equal(d.retryable, true);
});

test('an expiry with a real error behind it is still an expiry, and keeps the error', () => {
  // Errored on one tick (attempts 1, below the limit, so it stayed planned),
  // then the slot passed. The expiry is what ended it; the error is still the
  // interesting part and must remain reachable.
  const log = [entry(ERROR_STEP, 'semrush timeout'), entry(EXPIRED_STEP, EXPIRED_NOTE)];
  assert.equal(failureKind(log, 1, MAX), 'expired');
  assert.equal(lastErrorNote(log), 'semrush timeout');
});

test('an unknown cause reads as unknown — it is never dressed up as a specific one', () => {
  assert.equal(failureKind([], 0, MAX), 'unknown');
  assert.equal(failureKind(null, null, MAX), 'unknown');
  // Only research logged, nothing failed: we genuinely do not know.
  assert.equal(failureKind([entry('research', 'Angle: defend')], 1, MAX), 'unknown');

  const advice = failureAdvice('unknown', null);
  assert.doesNotMatch(advice, /api key/i, 'an unknown cause was blamed on API keys');
  assert.match(advice, /did not record why/i);
});

test('no kind invents an API-key diagnosis', () => {
  // The regression guard for the whole module. The ONLY way "key" may appear is
  // when the engine's own recorded message says so.
  for (const kind of ['expired', 'stalled', 'unknown'] as const) {
    assert.doesNotMatch(failureAdvice(kind, null), /api key/i, kind + ' blamed API keys');
  }
  // ...and for an error it is the engine's sentence, whatever that sentence is.
  assert.equal(failureAdvice('error', 'OPENAI_API_KEY missing'), 'OPENAI_API_KEY missing');
});

// --- ordering ----------------------------------------------------------------

test('lastFailure finds the failure, not merely the last line', () => {
  const log = [entry(ERROR_STEP, 'draft insert failed: timeout'), entry('retry', 'Manual retry — restarting from research.')];
  assert.equal(lastEntry(log)?.step, 'retry');
  assert.equal(lastFailure(log)?.step, ERROR_STEP);
});

test('the most recent error wins when there are several', () => {
  const log = [entry(ERROR_STEP, 'first'), entry('retry', 'again'), entry(ERROR_STEP, 'second')];
  assert.equal(lastErrorNote(log), 'second');
});

test('history reads newest first and does not mutate the input', () => {
  const log = [entry('research', 'a'), entry('error', 'b'), entry('expired', 'c')];
  const before = JSON.stringify(log);
  const shown = historyForDisplay(log);
  assert.deepEqual(shown.map((e) => e.note), ['c', 'b', 'a']);
  assert.equal(JSON.stringify(log), before, 'historyForDisplay reversed the caller’s array in place');
});

// --- the card cannot contradict the engine -----------------------------------

test('the hardcoded sentence is gone from the panel', () => {
  // The defect itself. A source check, because the component imports React and
  // cannot be executed here — and because this exact string reappearing is the
  // failure mode worth catching.
  const src = readFileSync(new URL('../app/AutopilotQueue.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /repeated errors; check API keys/, 'the hardcoded diagnosis is back');
  assert.match(src, /describeFailure\(/, 'the card no longer asks run-failure for the reason');
});

test('MAX_ATTEMPTS here matches the engine', () => {
  const src = readFileSync(new URL('./planner-constants.ts', import.meta.url), 'utf8');
  const m = src.match(/MAX_ATTEMPTS\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_ATTEMPTS not found in planner-constants.ts');
  assert.equal(Number(m[1]), MAX, 'these tests are calibrated to the wrong MAX_ATTEMPTS');
});

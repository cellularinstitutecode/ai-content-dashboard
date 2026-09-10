import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureKind, maxAttemptsFor, mayRetry, whyStopped } from './failure-kind.ts';

test('the clock and a thrown writer are worth trying again', () => {
  assert.equal(failureKind('out_of_time'), 'transient');
  assert.equal(failureKind('generation_failed'), 'transient');
  assert.equal(failureKind('transcript_ready'), 'transient');
});

test('a refusal a person has to answer is terminal', () => {
  assert.equal(failureKind('no_transcript'), 'terminal');
  assert.equal(failureKind('named_a_person'), 'terminal');
  assert.equal(failureKind('no_citation'), 'terminal');
  assert.equal(failureKind('invalid_url'), 'terminal');
});

test('a missing migration blocks rather than fails', () => {
  assert.equal(failureKind('transcript_not_kept'), 'blocked');
  assert.equal(failureKind('migration_pending'), 'blocked');
});

test('an unknown or absent code is retried, not retired', () => {
  // Defaulting to terminal would silently stop working on any code added
  // later, which is the failure this module exists to end.
  assert.equal(failureKind('something_new'), 'transient');
  assert.equal(failureKind(null), 'transient');
  assert.equal(failureKind(''), 'transient');
  assert.equal(failureKind(undefined), 'transient');
});

test('a timeout keeps its retries; a refusal does not get a second one', () => {
  assert.equal(maxAttemptsFor('transient'), 5);
  assert.equal(maxAttemptsFor('terminal'), 1);
  assert.equal(maxAttemptsFor('blocked'), 1);
});

test('the old flat wall no longer retires a row that only ran out of time', () => {
  // Three timeouts used to be permanent. It is the case this was written for.
  assert.equal(mayRetry('out_of_time', 3), true);
  assert.equal(mayRetry('out_of_time', 5), false);
});

test('a terminal failure stops after the attempt that produced it', () => {
  // The refusal is already in hand; a second transcription buys the same one.
  assert.equal(mayRetry('named_a_person', 1), false);
  assert.equal(mayRetry('no_transcript', 1), false);
});

test('a row that has never failed is always eligible', () => {
  assert.equal(mayRetry(null, 0), true);
});

test('a row still within its allowance explains nothing', () => {
  assert.equal(whyStopped('out_of_time', 2), null);
});

test('a stopped row says which kind of stopped it is', () => {
  assert.match(String(whyStopped('transcript_not_kept', 1)), /database update/i);
  assert.match(String(whyStopped('named_a_person', 1)), /needs you/i);
  assert.match(String(whyStopped('out_of_time', 5)), /5 times/);
});

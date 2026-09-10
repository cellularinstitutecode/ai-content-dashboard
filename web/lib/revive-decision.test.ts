import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REVIVALS, REVIVE_COOLDOWN_MS, reviveDecision } from './revive-decision.ts';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('a live claim is left alone', () => {
  // Another sweep is working on it right now; touching it means paying twice.
  assert.equal(reviveDecision({ state: 'preparing', attempts: 1, updated_at: ago(60_000) }, NOW), 'leave');
});

test('a claim from a run that died is handed back', () => {
  assert.equal(reviveDecision({ state: 'preparing', attempts: 1, updated_at: ago(30 * 60_000) }, NOW), 'release');
});

test('a claim with no timestamp counts as dead, not as held', () => {
  // The alternative locks the row out forever on a single bad write.
  assert.equal(reviveDecision({ state: 'preparing', attempts: 1, updated_at: null }, NOW), 'release');
});

test('a timeout past its cooldown gets a clean slate', () => {
  assert.equal(
    reviveDecision({ state: 'failed', attempts: 5, last_error_code: 'out_of_time', updated_at: ago(REVIVE_COOLDOWN_MS + 1000) }, NOW),
    'revive',
  );
});

test('a timeout still inside its cooldown waits', () => {
  assert.equal(
    reviveDecision({ state: 'failed', attempts: 5, last_error_code: 'out_of_time', updated_at: ago(60_000) }, NOW),
    'leave',
  );
});

test('a failure a person must answer is never revived', () => {
  // Reviving it would buy another download and another transcription to reach
  // the same refusal.
  for (const code of ['no_transcript', 'named_a_person', 'invalid_url']) {
    assert.equal(
      reviveDecision({ state: 'failed', attempts: 1, last_error_code: code, updated_at: ago(REVIVE_COOLDOWN_MS * 10) }, NOW),
      'needs_human',
      code,
    );
  }
});

test('a missing migration is named, not retried', () => {
  assert.equal(
    reviveDecision({ state: 'failed', attempts: 1, last_error_code: 'transcript_not_kept', updated_at: ago(REVIVE_COOLDOWN_MS * 10) }, NOW),
    'needs_human',
  );
});

test('reviving has a ceiling, so a cooldown does not become an endless retry', () => {
  const row = { state: 'failed', attempts: 5, last_error_code: 'out_of_time', updated_at: ago(REVIVE_COOLDOWN_MS * 10) };
  assert.equal(reviveDecision({ ...row, revivals: MAX_REVIVALS - 1 }, NOW), 'revive');
  assert.equal(reviveDecision({ ...row, revivals: MAX_REVIVALS }, NOW), 'needs_human');
});

test('a row that is done or waiting is not the revive pass’s business', () => {
  assert.equal(reviveDecision({ state: 'prepared', attempts: 1, updated_at: ago(1) }, NOW), 'leave');
  assert.equal(reviveDecision({ state: 'discovered', attempts: 0, updated_at: ago(1) }, NOW), 'leave');
});

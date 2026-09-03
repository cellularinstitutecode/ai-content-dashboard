// The images check on /api/health was `has('OPENAI_API_KEY')`. The key was set.
// The OpenAI account had been out of credit for days, so every generation, the
// vision check that keeps text off the images, and the voice assistant were all
// failing — and the endpoint a coordinator is told to look at said everything
// was fine. These tests pin the signal that replaced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyImageFailure, OUTCOME_WINDOW_MS } from './image-failure-reason.ts';

// What lib/images.ts actually throws: `openai images <status>: <body>`.
const OUT_OF_CREDIT =
  'openai images 429: {"error":{"message":"Your credit balance is too low to access the OpenAI API","type":"invalid_request_error","code":"credit_balance_exhausted"}}';

test('an empty OpenAI wallet is read as an empty wallet, not a busy minute', () => {
  // OpenAI answers 429 for BOTH "too fast" and "out of credit". Testing the
  // status first would file this under rate_limited, the banner would say it
  // usually clears itself, and nobody would ever go and top the account up.
  assert.equal(classifyImageFailure(OUT_OF_CREDIT), 'no_credit');
  assert.equal(classifyImageFailure('openai images 429: insufficient_quota'), 'no_credit');
  assert.equal(classifyImageFailure('openai images 400: billing_hard_limit_reached'), 'no_credit');
});

test('a genuine rate limit is still a rate limit', () => {
  assert.equal(classifyImageFailure('openai images 429: {"code":"rate_limit_exceeded"}'), 'rate_limited');
});

test('a rejected key is not confused with a spent one', () => {
  // These want opposite actions: top up the account vs. reissue the key.
  assert.equal(classifyImageFailure('openai images 401: {"code":"invalid_api_key"}'), 'bad_key');
  assert.notEqual(classifyImageFailure('openai images 401: {"code":"invalid_api_key"}'), 'no_credit');
});

test('anything unrecognised is reported as unknown rather than guessed at', () => {
  assert.equal(classifyImageFailure('openai images 503: upstream unavailable'), 'other');
  assert.equal(classifyImageFailure(''), 'other');
});

test('a failure stops being evidence after a day', () => {
  // Without a window, one bad afternoon would leave the banner up forever —
  // which is how a status signal stops being read at all.
  assert.equal(OUTCOME_WINDOW_MS, 24 * 60 * 60 * 1000);
});

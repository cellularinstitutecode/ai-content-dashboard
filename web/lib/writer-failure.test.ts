import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWriterFailure, writerFailure } from './writer-failure.ts';

test('a rejected key and a rate limit are told apart', () => {
  // Both are "the writer refused". One needs somebody to change a setting, the
  // other needs sixty seconds — and one sentence for both wastes an afternoon.
  const key = describeWriterFailure(new Error('anthropic 401: {"type":"error","error":{"type":"authentication_error"}}'));
  assert.match(key.said, /rejected the key/);
  assert.equal(key.retryable, false);

  const limit = describeWriterFailure(new Error('anthropic 429: {"type":"rate_limit_error"}'));
  assert.match(limit.said, /rate-limiting/);
  assert.equal(limit.retryable, true);
});

test('an empty account is not a rate limit, though it arrives as one', () => {
  const broke = describeWriterFailure(new Error('openai 429: {"error":{"code":"insufficient_quota"}}'));
  assert.match(broke.said, /out of credit/);
  assert.equal(broke.retryable, false, 'pressing the button again cannot buy credit');
});

test('no provider configured is named as such', () => {
  const none = describeWriterFailure(new Error('ANTHROPIC_API_KEY missing'));
  assert.match(none.said, /no AI is connected/);
  assert.equal(none.retryable, false);
});

test('a prompt over the context limit is not worth repeating', () => {
  const big = describeWriterFailure(new Error('anthropic 400: {"error":{"message":"prompt is too long: 250000 tokens"}}'));
  assert.match(big.said, /too long for the model/);
  assert.equal(big.retryable, false);
});

test('the provider having a bad minute is worth another press', () => {
  const oops = describeWriterFailure(new Error('anthropic 529: overloaded'));
  assert.match(oops.said, /error at its end/);
  assert.equal(oops.retryable, true);
});

test('running out of clock says so rather than blaming the provider', () => {
  // The failure that produced this file: the writer was given 60s and wanted 92.
  const slow = describeWriterFailure(new Error('request to https://api.anthropic.com/v1/messages failed after 3 attempts: The operation was aborted'));
  assert.match(slow.said, /ran out of time/);
  assert.equal(slow.retryable, true);
});

test('an unrecognised failure admits that rather than inventing a cause', () => {
  const odd = describeWriterFailure(new Error('something nobody anticipated'));
  assert.equal(odd.said, 'the reason was not recorded');
  assert.equal(odd.retryable, true);
  assert.equal(writerFailure(new Error('anthropic 500: x')), 'the AI provider had an error at its end');
  // Non-Error throws must not crash the reporter.
  assert.ok(writerFailure('a string').length > 0);
  assert.ok(writerFailure(null).length > 0);
});

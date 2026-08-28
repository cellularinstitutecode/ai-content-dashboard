// The mapping that decides what a person is told when a request fails.
//
// The regression that made this file necessary: middleware answers
// {"error":"unauthenticated"} for an expired session, and the dashboard's own
// mapping tested /unauthor/ — which does not match "unauthenticated". So the
// coordinator was told the AI provider had rejected its API key and went
// hunting for a billing problem that did not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, GENERIC_FAILURE } from './friendly-error.ts';

test('an expired session is reported as an expired session', () => {
  for (const body of [{ error: 'unauthenticated' }, { error: 'unauthorized' }, 'unauthenticated']) {
    const said = friendlyError(body);
    assert.match(said, /session/i, JSON.stringify(body));
    assert.doesNotMatch(said, /API key/i, 'must not blame the AI provider: ' + JSON.stringify(body));
  }
});

test('a message written by our own API always wins', () => {
  const said = friendlyError({
    error: 'metricool_update_failed',
    message: 'We could not move this post in Metricool, so it has been left where it was.',
  });
  assert.equal(said, 'We could not move this post in Metricool, so it has been left where it was.');
});

test('a bare machine code is never shown to a person', () => {
  for (const code of ['metricool_delete_failed', 'tick_failed', 'opus_failed', 'pgrst116']) {
    const said = friendlyError({ error: code });
    assert.ok(!said.includes(code), code + ' leaked to the user: ' + said);
    assert.equal(said, GENERIC_FAILURE);
  }
});

test('known codes read as sentences', () => {
  assert.match(friendlyError({ error: 'forbidden' }), /not authorized/i);
  assert.match(friendlyError({ error: 'rate_limited' }), /few minutes|requests/i);
  assert.match(friendlyError({ error: 'not_found' }), /could not find/i);
});

test('provider failures keep their existing, useful advice', () => {
  assert.match(friendlyError('openai 400 insufficient_quota'), /out of credit/i);
  assert.match(friendlyError('anthropic 429: overloaded'), /busy/i);
  assert.match(friendlyError('anthropic 401: invalid_api_key'), /API key/i);
});

test('an upstream body is never echoed verbatim past 200 characters', () => {
  const huge = 'Metricool rejected the request because ' + 'x'.repeat(500);
  const said = friendlyError(huge);
  assert.ok(said.length <= 201, 'length was ' + said.length);
});

test('nothing at all still produces a sentence', () => {
  assert.equal(friendlyError(null), GENERIC_FAILURE);
  assert.equal(friendlyError({}), GENERIC_FAILURE);
  assert.equal(friendlyError(''), GENERIC_FAILURE);
});

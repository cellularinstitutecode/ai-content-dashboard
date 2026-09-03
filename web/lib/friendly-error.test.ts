// The mapping that decides what a person is told when a request fails.
//
// The regression that made this file necessary: middleware answers
// {"error":"unauthenticated"} for an expired session, and the dashboard's own
// mapping tested /unauthor/ — which does not match "unauthenticated". So the
// coordinator was told the AI provider had rejected its API key and went
// hunting for a billing problem that did not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, friendlyImageError, GENERIC_FAILURE, OPENAI_OUT_OF_CREDIT } from './friendly-error.ts';

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

// --- image failures -------------------------------------------------------
//
// A generation wrote and saved the text pack, then the Hero image step turned
// red still saying "Generating an on-brand visual…". The body said
// `openai images 429 … credit_balance_exhausted`. The shared mapping answers
// that with "switch the model to Claude (Anthropic)" — right for text, useless
// for a picture, because there is no other image provider to switch to.

// What lib/images.ts throws and app/api/drafts/image relays as { error }.
const OUT_OF_CREDIT = {
  error: 'image generation failed: openai images 429: {"error":{"message":"Your credit balance is too low to access the OpenAI API","type":"invalid_request_error","code":"credit_balance_exhausted"}}',
};

test('an image path names the OpenAI account, not a model switch', () => {
  const said = friendlyImageError(OUT_OF_CREDIT, 'fallback', { provider: 'openai' });
  assert.match(said, /OpenAI account is out of credit/);
  assert.doesNotMatch(said, /switch the model/i);
  assert.doesNotMatch(said, /Claude/);
});

test('the raw provider body never reaches the person', () => {
  const said = friendlyImageError(OUT_OF_CREDIT, 'fallback', { provider: 'openai' });
  assert.doesNotMatch(said, /credit_balance_exhausted|invalid_request_error|\{/);
});

test('what survived the failure is said too, when the caller knows', () => {
  assert.equal(
    friendlyImageError(OUT_OF_CREDIT, 'fallback', { provider: 'openai', alsoSay: 'Your text is saved.' }),
    OPENAI_OUT_OF_CREDIT + ' Your text is saved.',
  );
  assert.equal(friendlyImageError(OUT_OF_CREDIT, 'fallback', { provider: 'openai' }), OPENAI_OUT_OF_CREDIT);
});

test('any other image failure keeps the shared advice', () => {
  assert.match(friendlyImageError({ error: 'openai images 504: upstream timed out' }, 'fallback', { provider: 'openai' }), /took too long/i);
  assert.equal(friendlyImageError({}, 'the picture failed', { provider: 'openai' }), 'the picture failed');
});

test('a caller that cannot know the provider does not guess one', () => {
  // The Autopilot engine runs Claude for the words and OpenAI for the picture
  // in a single call. Blaming OpenAI for an Anthropic bill would send a person
  // to top up the wrong account.
  const anthropic = { error: 'anthropic 400: {"type":"invalid_request_error","message":"credit_balance_exhausted"}' };
  const said = friendlyImageError(anthropic, 'fallback');
  assert.doesNotMatch(said, /OpenAI/);
  assert.match(said, /out of credit/i);
  // ...but it still names OpenAI when the body itself does.
  assert.match(friendlyImageError(OUT_OF_CREDIT, 'fallback'), /OpenAI account is out of credit/);
});

test('an Error and a bare string are read the same as a body', () => {
  assert.match(friendlyImageError(new Error('openai images 429: credit_balance_exhausted'), 'fallback'), /OpenAI account/);
  assert.match(friendlyImageError('openai images 429: insufficient_quota', 'fallback'), /OpenAI account/);
  assert.equal(friendlyImageError(null, 'fallback'), 'fallback');
});

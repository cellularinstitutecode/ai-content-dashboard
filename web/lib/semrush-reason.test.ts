// Why a Semrush call failed decides what the dashboard SHOWS: a quiet
// "serving stored data" note, or an amber warning telling a human to go fix a
// credential. Getting that wrong is what made a permanent, unfixable-by-retry
// account state ("your key is a v4 key") render as "Semrush rejected the API
// key — verify SEMRUSH_API_KEY", sending the user to re-paste a key that could
// never work. These tests pin the mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasonForCode, reasonForHttpStatus, isInformationalReason, semrushMessage, semrushDraftNote } from './semrush-reason.ts';

test('ERROR 122 (a v4 key on a v3 endpoint) is v3_key, never a credential fault', () => {
  // The exact code the live account returned: "ERROR 122 :: WRONG FORMAT OR
  // EMPTY KEY". Before this mapping existed it fell through to 'http' and the
  // UI reported an unexplained failure.
  assert.equal(reasonForCode(122), 'v3_key');
  assert.equal(reasonForCode(121), 'v3_key');
  assert.notEqual(reasonForCode(122), 'auth');
});

test('a genuinely bad or unknown key is still auth — the one a human must fix', () => {
  assert.equal(reasonForCode(110), 'auth'); // INVALID IMPORT KEY
  assert.equal(reasonForCode(120), 'auth'); // WRONG KEY - ID PAIR
  assert.equal(isInformationalReason('auth'), false, 'auth must stay loud');
});

test('plan/units restrictions map to plan, and "nothing found" is not an error', () => {
  for (const code of [130, 131, 132, 133, 134, 135]) {
    assert.equal(reasonForCode(code), 'plan', 'code ' + code);
  }
  assert.equal(reasonForCode(50), 'empty');
});

test('an unrecognised error code degrades to http rather than guessing', () => {
  assert.equal(reasonForCode(999), 'http');
  assert.equal(reasonForCode(0), 'http');
});

test('403 is an entitlement answer (v3_key); 401 is a credential answer (auth)', () => {
  // The Projects API (Site Audit, Position Tracking) answered 403 on the live
  // account. Treating that as 'auth' is what produced "verify SEMRUSH_API_KEY".
  assert.equal(reasonForHttpStatus(403), 'v3_key');
  assert.equal(reasonForHttpStatus(401), 'auth');
});

test('402/429 are plan states, and anything else is plain http', () => {
  assert.equal(reasonForHttpStatus(402), 'plan');
  assert.equal(reasonForHttpStatus(429), 'plan');
  assert.equal(reasonForHttpStatus(500), 'http');
  assert.equal(reasonForHttpStatus(502), 'http');
});

test('informational states are exactly the ones no user action can clear', () => {
  for (const r of ['no_token', 'v3_key', 'budget', 'empty'] as const) {
    assert.equal(isInformationalReason(r), true, r + ' should read as quiet info');
  }
  for (const r of ['auth', 'plan', 'http', 'network'] as const) {
    assert.equal(isInformationalReason(r), false, r + ' should stay actionable/amber');
  }
  assert.equal(isInformationalReason(undefined), false);
});

// --- What the person is told ---------------------------------------------
// The dashboard used to hard-code "Semrush API key not set" for every one of
// these. On the live account the key WAS set and the real reason was the unit
// floor, so the message sent people hunting for a key that was not missing.

test('a budget pause never blames the key', () => {
  const msg = semrushMessage('budget');
  assert.match(msg, /paused/i);
  // \b so "Keyword research" does not read as the word "key".
  assert.doesNotMatch(msg, /\bkeys?\b/i);
});

test('only a genuinely absent credential mentions a key', () => {
  assert.match(semrushMessage('no_token'), /\bkey\b/i);
  assert.match(semrushMessage('auth'), /\bkey\b/i);
  for (const r of ['budget', 'plan', 'v3_key', 'http', 'network', 'empty'] as const) {
    assert.doesNotMatch(semrushMessage(r), /add the Semrush key/i, r + ' should not ask for a key');
  }
});

test('no message leaks an environment variable name or a machine code', () => {
  for (const r of ['no_token', 'auth', 'plan', 'v3_key', 'http', 'network', 'empty', 'budget'] as const) {
    assert.doesNotMatch(semrushMessage(r), /SEMRUSH_|_API_KEY|ERROR \d|HTTP \d/, r + ' leaked internals');
  }
});

test('a healthy lookup says nothing at all', () => {
  assert.equal(semrushMessage('ok'), '');
  assert.equal(semrushMessage(undefined), '');
});

test('the draft note leads with the draft being fine', () => {
  assert.match(semrushDraftNote('budget'), /^Written without live keyword data\./);
  assert.match(semrushDraftNote(undefined), /^Written without live keyword data\.$/);
});

// --- The one that hid for weeks ------------------------------------------
test('an unreadable balance is its own reason, never "at the floor"', () => {
  const msg = semrushMessage('balance_unknown');
  assert.match(msg, /cannot confirm/i);
  assert.match(msg, /ask whoever set this up/i);
  assert.doesNotMatch(msg, /protection floor/i);
});

test('an unreadable balance is actionable, so it is not informational', () => {
  assert.equal(isInformationalReason('balance_unknown'), false);
  assert.equal(isInformationalReason('budget'), true);
});

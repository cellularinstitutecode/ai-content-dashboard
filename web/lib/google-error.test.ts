// A 403 from Google is at least four different problems needing four different
// actions, and the dashboard used to answer all of them with "share it with the
// service account". On the clinic's documents — already shared with
// anyone-who-has-the-link — that was the one thing that was not broken, so the
// message sent people round in circles. These pin the classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoogleError } from './google-error.ts';

// The bodies Google actually returns.
const API_DISABLED = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED',
  message: 'Google Sheets API has not been used in project 504518 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=504518 then retry.' } });
const NOT_SHARED = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED',
  message: 'The caller does not have permission' } });
const BAD_SCOPES = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED',
  message: 'Request had insufficient authentication scopes.' } });
const NOT_FOUND = JSON.stringify({ error: { code: 404, status: 'NOT_FOUND',
  message: 'Requested entity was not found.' } });
const BAD_KEY = JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });

test('an API that was never switched on is not a sharing problem', () => {
  // The most likely cause on a fresh Cloud project, and the one the old
  // message could never say. Re-sharing the document does nothing for it.
  const r = classifyGoogleError(403, API_DISABLED);
  assert.equal(r.reason, 'api_disabled');
  assert.match(r.detail, /has not been used in project/);
});

test('a genuine permission refusal is still reported as one', () => {
  assert.equal(classifyGoogleError(403, NOT_SHARED).reason, 'not_shared');
});

test('missing scopes are a credentials problem, not a document problem', () => {
  assert.equal(classifyGoogleError(403, BAD_SCOPES).reason, 'bad_scopes');
});

test('a wrong id is a wrong id', () => {
  assert.equal(classifyGoogleError(404, NOT_FOUND).reason, 'not_found');
});

test('a broken service-account key is named as such', () => {
  assert.equal(classifyGoogleError(400, BAD_KEY).reason, 'bad_credentials');
  assert.equal(classifyGoogleError(401, '{}').reason, 'bad_credentials');
});

test('rate limiting is temporary and says so', () => {
  assert.equal(classifyGoogleError(429, '{}').reason, 'rate_limited');
});

test("Google's own sentence survives, so a person can read it", () => {
  // Every classification keeps the detail: when our mapping is wrong, the
  // reader can still see what Google said and act on that instead.
  for (const body of [API_DISABLED, NOT_SHARED, BAD_SCOPES, NOT_FOUND]) {
    assert.ok(classifyGoogleError(403, body).detail.length > 0, body);
  }
});

test('an unparseable body does not become a confident diagnosis', () => {
  const r = classifyGoogleError(500, '<html>502 Bad Gateway</html>');
  assert.equal(r.reason, 'unknown');
  assert.match(r.detail, /Bad Gateway/);
});

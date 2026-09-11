// Unit tests for the Drive copy diagnosis. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFailureAdvice, storageAdvice } from './drive-copy-error.ts';

test('a missing folder is a deployment problem, not a Drive one', () => {
  const a = copyFailureAdvice(new Error('DRIVE_FOLDER_ID missing'));
  assert.equal(a.reason, 'no_folder');
  assert.match(a.message, /DRIVE_FOLDER_ID/);
});

// The one that reads as a plain 403 and is not a sharing problem at all.
test('copying disabled by the file owner is told apart from no access', () => {
  const err = { code: 403, errors: [{ reason: 'cannotCopyFile', message: 'Cannot copy file.' }] };
  const a = copyFailureAdvice(err);
  assert.equal(a.reason, 'copy_forbidden');
  assert.match(a.message, /switched off copying/);
  assert.doesNotMatch(a.message, /service account/, 'sending someone to re-share an already-shared file is the wrong advice');
});

test('a Workspace policy blocking link-sharing names the admin, not the file', () => {
  const err = { code: 403, errors: [{ reason: 'sharingRateLimitExceeded' }] };
  assert.equal(copyFailureAdvice(err).reason, 'sharing_blocked');
  assert.equal(copyFailureAdvice({ code: 403, message: 'Sharing is not allowed by domain policy' }).reason, 'sharing_blocked');
});

test('a full Drive says so rather than blaming permissions', () => {
  assert.equal(copyFailureAdvice({ code: 403, errors: [{ reason: 'storageQuotaExceeded' }] }).reason, 'out_of_space');
});

test('rate limiting is the one case where "try again" is right', () => {
  assert.equal(copyFailureAdvice({ code: 429 }).reason, 'rate_limited');
  assert.equal(copyFailureAdvice({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }).reason, 'rate_limited');
});

test('a file the service account cannot see asks for the share', () => {
  const a = copyFailureAdvice({ code: 404, message: 'File not found: abc123.' });
  assert.equal(a.reason, 'no_access');
  assert.match(a.message, /service account/);
  assert.equal(copyFailureAdvice({ code: 403, message: 'The user does not have sufficient permissions' }).reason, 'no_access');
});

test('an unrecognised refusal repeats what Google actually said', () => {
  const a = copyFailureAdvice(new Error('Backend Error'));
  assert.equal(a.reason, 'unknown');
  // The point of the whole module: never swallow the one clue there is.
  assert.match(a.message, /Backend Error/);
});

test('nothing thrown at all still produces a sentence', () => {
  assert.equal(copyFailureAdvice(null).reason, 'unknown');
  assert.ok(copyFailureAdvice(undefined).message.length > 0);
});

// --- the two problems behind one Google error code ---------------------------
//
// storageQuotaExceeded means either "the drive is full" or "the service account
// has no storage at all". Telling someone to clear space is useless advice for
// the second, which is also the commoner one and the one that never recovers.
test('a My Drive folder is named as the cause, not blamed on being full', () => {
  const a = storageAdvice(false);
  assert.equal(a.reason, 'no_shared_drive');
  assert.match(a.message, /Shared Drive/);
  assert.match(a.message, /clearing space will not help/i);
});

test('a Shared Drive that is genuinely full says to clear space', () => {
  const a = storageAdvice(true);
  assert.equal(a.reason, 'out_of_space');
  assert.match(a.message, /Clear space/);
  assert.doesNotMatch(a.message, /service account owns no storage/);
});

test('the generic storage message points at the check that can tell them apart', () => {
  const a = copyFailureAdvice({ code: 403, errors: [{ reason: 'storageQuotaExceeded' }] });
  assert.equal(a.reason, 'out_of_space');
  assert.match(a.message, /drive_storage/);
});

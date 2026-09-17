import test from 'node:test';
import assert from 'node:assert/strict';
import { publishMode, publishesOnSend } from './publish-mode.ts';

test('posts are scheduled by default — they go out at their slot', () => {
  assert.equal(publishMode({}), 'scheduled');
  assert.equal(publishesOnSend({}), true);
});

test('PUBLISH_MODE=review puts the approve-first step back', () => {
  for (const value of ['review', 'REVIEW', ' review ', 'draft', 'drafts']) {
    assert.equal(publishMode({ PUBLISH_MODE: value }), 'review', value);
    assert.equal(publishesOnSend({ PUBLISH_MODE: value }), false, value);
  }
});

test('anything unrecognised is scheduled, not a third behaviour', () => {
  // A typo must not invent a mode. Two outcomes exist and a value that is
  // neither falls to the documented default rather than to something nobody
  // chose.
  for (const value of ['', '   ', 'yes', 'on', 'live', 'scheduled', 'publish']) {
    assert.equal(publishMode({ PUBLISH_MODE: value }), 'scheduled', JSON.stringify(value));
  }
  assert.equal(publishMode({ PUBLISH_MODE: undefined }), 'scheduled');
});

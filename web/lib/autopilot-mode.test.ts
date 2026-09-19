// web/lib/autopilot-mode.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSchedules, autopilotMode } from './autopilot-mode.ts';

test('unset means a person still approves', () => {
  // The one that matters most: shipping this file must change nothing until
  // somebody deliberately turns it on.
  assert.equal(autopilotMode({}), 'review');
  assert.equal(autoSchedules({}), false);
  assert.equal(autoSchedules({ AUTOPILOT_AUTOSCHEDULE: undefined }), false);
});

test('only a deliberate yes turns it on', () => {
  for (const value of ['on', 'ON', ' on ', 'true', 'yes', '1', 'scheduled']) {
    assert.equal(autoSchedules({ AUTOPILOT_AUTOSCHEDULE: value }), true, JSON.stringify(value));
  }
});

test('anything unreadable leaves the approval step where it is', () => {
  // A typo must not be the difference between a review queue and a megaphone.
  for (const value of ['', '  ', 'off', 'false', 'no', '0', 'auto', 'onn', 'review', 'maybe', 'y']) {
    assert.equal(autoSchedules({ AUTOPILOT_AUTOSCHEDULE: value }), false, JSON.stringify(value));
  }
});

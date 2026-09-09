import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextFreeSlot, networksFor, NEEDS_VIDEO, POST_WEEKDAYS } from './video-slot.ts';

const TZ = 'America/Cancun';
// A Wednesday, mid-afternoon in Cancun (UTC-5).
const WED_AFTERNOON = new Date('2026-09-09T20:00:00Z');

test('the next slot is the next weekday morning', () => {
  const slot = nextFreeSlot([], WED_AFTERNOON, TZ);
  assert.ok(slot);
  // 09:00 Cancun (UTC-5) is 14:00 UTC, on Thursday.
  assert.equal(slot.toISOString(), '2026-09-10T14:00:00.000Z');
});

test('a backlog spreads across days instead of stacking on one morning', () => {
  // Thirty rows worked off in one go must become thirty mornings, not one
  // morning with thirty posts on it — that reads as spam on every network.
  const taken: string[] = [];
  const slots: string[] = [];
  for (let i = 0; i < 5; i++) {
    const slot = nextFreeSlot(taken, WED_AFTERNOON, TZ);
    assert.ok(slot, 'ran out of slots');
    slots.push(slot.toISOString());
    taken.push(slot.toISOString());
  }
  assert.equal(new Set(slots).size, 5, 'every slot must be distinct');
  assert.deepEqual(slots, [
    '2026-09-10T14:00:00.000Z', // Thu
    '2026-09-11T14:00:00.000Z', // Fri
    '2026-09-14T14:00:00.000Z', // Mon — the weekend is skipped
    '2026-09-15T14:00:00.000Z', // Tue
    '2026-09-16T14:00:00.000Z', // Wed
  ]);
});

test('posts already in the queue are not doubled up on', () => {
  const slot = nextFreeSlot(['2026-09-10T14:00:00.000Z'], WED_AFTERNOON, TZ);
  assert.equal(slot?.toISOString(), '2026-09-11T14:00:00.000Z');
});

test('weekends are never scheduled', () => {
  assert.deepEqual(POST_WEEKDAYS, [1, 2, 3, 4, 5]);
  const taken: string[] = [];
  for (let i = 0; i < 12; i++) {
    const slot = nextFreeSlot(taken, WED_AFTERNOON, TZ);
    assert.ok(slot);
    const day = new Date(slot).getUTCDay();
    assert.ok(day >= 1 && day <= 5, 'scheduled on day ' + day);
    taken.push(slot.toISOString());
  }
});

test('a row with no ticks defaults to LinkedIn', () => {
  // LinkedIn is the one network whose post is complete without a video file.
  assert.deepEqual(networksFor([], false), ['linkedin']);
  assert.deepEqual(networksFor([], true), ['linkedin']);
});

test('the sheet’s ticks are followed where they are set', () => {
  assert.deepEqual(networksFor(['linkedin', 'tiktok'], true), ['linkedin', 'tiktok']);
  assert.deepEqual(networksFor(['facebook'], false), ['facebook']);
});

test('a network that needs a video is dropped when there is no video URL', () => {
  // A TikTok draft with no video is not something a person can approve — it is
  // a chore they have to finish by hand.
  assert.deepEqual(networksFor(['linkedin', 'tiktok', 'instagram'], false), ['linkedin']);
  assert.ok(NEEDS_VIDEO.has('tiktok'));
  assert.ok(NEEDS_VIDEO.has('instagram'));
  assert.ok(!NEEDS_VIDEO.has('linkedin'));
});

test('email is a sheet column, not a network Metricool posts to', () => {
  assert.deepEqual(networksFor(['linkedin', 'email'], true), ['linkedin']);
  assert.deepEqual(networksFor(['email'], true), []);
});

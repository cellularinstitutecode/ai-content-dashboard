import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NEEDS_VIDEO, POST_WEEKDAYS, fitsAspect, networksFor, nextFreeSlot, reserveSlots } from './video-slot.ts';

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

test('a row with no ticks goes to all three video destinations', () => {
  // It used to default to LinkedIn alone, on the reasoning that LinkedIn is the
  // one network complete without a video attached. True, and beside the point:
  // nobody ticks the boxes, so every prepared video reached exactly one network
  // and the other two were never touched.
  assert.deepEqual(networksFor([], true), ['youtube', 'linkedin', 'tiktok']);
  // Without a video the two that require one still drop out, which is the half
  // of the old behaviour that was right.
  assert.deepEqual(networksFor([], false), ['linkedin']);
});

test('a horizontal video is kept off TikTok and kept on YouTube', () => {
  // TikTok is a vertical feed — 16:9 there is letterboxed or cropped through
  // the middle of the shot. Landscape is simply what a YouTube video looks
  // like, so it is not treated as a problem.
  assert.deepEqual(networksFor([], true, 'Horizontal 16:9'), ['youtube', 'linkedin']);
  assert.deepEqual(networksFor([], true, 'Vertical 9:16'), ['youtube', 'linkedin', 'tiktok']);
  assert.equal(fitsAspect('tiktok', 'Horizontal 16:9'), false);
  assert.equal(fitsAspect('youtube', 'Horizontal 16:9'), true);
  assert.equal(fitsAspect('linkedin', 'Horizontal 16:9'), true);
});

test('a blank or unreadable format is not a reason to refuse a post', () => {
  // FORMATO is a human note in a spreadsheet. Refusing to post because
  // somebody left the cell empty would be the tool inventing a rule.
  assert.equal(fitsAspect('tiktok', ''), true);
  assert.equal(fitsAspect('tiktok', null), true);
  assert.equal(fitsAspect('tiktok', 'no idea'), true);
  // And a caller that passes nothing at all keeps its old behaviour exactly.
  assert.deepEqual(networksFor([], true), networksFor([], true, undefined));
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

test('a batch reserves distinct slots in one go', () => {
  // Each row choosing for itself reads the same calendar before any of them has written
  // to it, so they all pick the same morning and the batch lands stacked on one instant.
  const slots = reserveSlots(5, []);
  assert.equal(slots.length, 5);
  assert.equal(new Set(slots.map((d) => d.toISOString())).size, 5, 'no two rows share an instant');
});

test('reserved slots respect what the calendar already holds', () => {
  const first = reserveSlots(1, [])[0];
  const next = reserveSlots(2, [first.toISOString()]);
  assert.ok(!next.some((d) => d.getTime() === first.getTime()), 'a taken slot is not handed out again');
  assert.equal(new Set(next.map((d) => d.toISOString())).size, 2);
});

test('asking for none, or for more than the horizon holds, is not an error', () => {
  assert.deepEqual(reserveSlots(0, []), []);
  // Fewer than asked for means the horizon ran out, which the caller reports rather than
  // treating as a failure.
  assert.ok(reserveSlots(10_000, []).length < 10_000);
});

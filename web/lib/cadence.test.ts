// web/lib/cadence.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFTS_PER_WEEK,
  MAX_LOOK_BACK,
  MIN_LOOK_BACK,
  VIDEO_POSTS_PER_WEEK,
  VIDEO_SLOTS_PER_DAY,
  openingLookBack,
} from './cadence.ts';
import { POSTS_PER_WEEK } from './content-strategy.ts';

test('a full week is the strategy plus the reels', () => {
  assert.equal(VIDEO_SLOTS_PER_DAY, 2, 'the sweep publishes two a day');
  assert.equal(VIDEO_POSTS_PER_WEEK, 14);
  assert.equal(DRAFTS_PER_WEEK, POSTS_PER_WEEK + VIDEO_POSTS_PER_WEEK);
  assert.equal(DRAFTS_PER_WEEK, 28);
});

test('the opening-line window covers a fortnight, not half a day', () => {
  // The number this replaces was 12. At the strategy's cadence that is about
  // four hours of publishing, which is a guard that has been switched off by
  // arithmetic happening somewhere else.
  assert.equal(openingLookBack(), 56);
  assert.ok(openingLookBack() > DRAFTS_PER_WEEK, 'must span more than one week');
  assert.ok(openingLookBack() > 12, 'must be wider than the number it replaces');
});

test('the window is bounded at both ends', () => {
  // A floor, so no cadence change makes it narrower than it already was; a
  // ceiling, because this becomes a row limit on a jsonb column and every row
  // carries a whole generated pack.
  assert.equal(openingLookBack(0), MIN_LOOK_BACK);
  assert.equal(openingLookBack(-3), MIN_LOOK_BACK);
  assert.equal(openingLookBack(999), MAX_LOOK_BACK);
  assert.ok(MIN_LOOK_BACK <= MAX_LOOK_BACK);
});

test('a fraction of a week rounds up, never down to zero', () => {
  assert.equal(openingLookBack(0.5), 14);
  assert.equal(openingLookBack(0.1), MIN_LOOK_BACK, 'the floor catches the small ones');
});

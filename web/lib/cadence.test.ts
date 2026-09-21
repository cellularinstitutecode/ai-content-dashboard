// web/lib/cadence.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLES_PER_WEEK,
  DRAFTS_PER_WEEK,
  MAX_LOOK_BACK,
  MIN_LOOK_BACK,
  VIDEO_POSTS_PER_WEEK,
  VIDEO_SLOTS_PER_DAY,
  openingLookBack,
} from './cadence.ts';
import { POSTS_PER_WEEK } from './content-strategy.ts';
import { seedRows } from './strategy-seed.ts';

test('a full week is the strategy, its article, and the reels', () => {
  assert.equal(VIDEO_SLOTS_PER_DAY, 2, 'the sweep publishes two a day');
  assert.equal(VIDEO_POSTS_PER_WEEK, 14);
  assert.equal(DRAFTS_PER_WEEK, POSTS_PER_WEEK + ARTICLES_PER_WEEK + VIDEO_POSTS_PER_WEEK);
  assert.equal(DRAFTS_PER_WEEK, 29);
});

test('and it counts every slot the seed actually writes', () => {
  // The article lives in lib/strategy-seed.ts, not in the day map, so
  // POSTS_PER_WEEK does not see it — and when it was added this file went on
  // saying 28. That is exactly the drift this module promises cannot happen,
  // so the two are tied together here rather than left to agree by luck.
  assert.equal(POSTS_PER_WEEK + ARTICLES_PER_WEEK, seedRows().length);
});

test('the opening-line window covers a fortnight, not half a day', () => {
  // The number this replaces was 12. At the strategy's cadence that is about
  // four hours of publishing, which is a guard that has been switched off by
  // arithmetic happening somewhere else.
  assert.equal(openingLookBack(), 58);
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
  assert.equal(openingLookBack(0.5), 15);
  assert.equal(openingLookBack(0.1), MIN_LOOK_BACK, 'the floor catches the small ones');
});

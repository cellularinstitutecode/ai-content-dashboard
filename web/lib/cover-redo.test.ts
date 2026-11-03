// Which covers the "Redo old covers" button redoes. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVER_RULE_SINCE, isOldCover, withoutHeadFlag } from './cover-redo.ts';

const old = { url: 'https://x/c.png', createdAt: '2026-10-20T19:12:00Z', titled: { title: 'Habits for Better *Sleep*', photoUrl: 'https://x/p.jpg' } };

test('a titled cover made before the rule is redone; one made after, one already redone, and one with no clean photo are not', () => {
  assert.equal(isOldCover(old), true);
  assert.equal(isOldCover({ ...old, createdAt: undefined }), true, 'no date: from before dates were recorded');
  assert.equal(isOldCover({ ...old, createdAt: COVER_RULE_SINCE }), false);
  assert.equal(isOldCover({ ...old, createdAt: '2026-11-03T10:00:00Z' }), false);
  assert.equal(isOldCover({ ...old, coverRedone: true }), false);
  assert.equal(isOldCover({ ...old, titled: { title: 'x', photoUrl: '' } }), false);
  assert.equal(isOldCover({ ...old, titled: { title: '', photoUrl: 'https://x/p.jpg' } }), false, 'a cover with its title turned off has nothing to redo');
  assert.equal(isOldCover({ ...old, url: '' }), false);
  assert.equal(isOldCover(null), false);
});

test('the head flag is dropped from a redone cover’s record, and the status follows what is left', () => {
  const flagged = { status: 'flagged', issues: ['a head reaches into the title area (top of head at 12% from the top)'], advisory: ['a sign on the wall'] };
  assert.deepEqual(withoutHeadFlag(flagged), { status: 'approved', issues: [], advisory: ['a sign on the wall'] });
  const two = { status: 'flagged', issues: ['a head reaches into the title area (top of head at 12% from the top)', 'off-topic — the picture does not show what this post is about'] };
  assert.deepEqual(withoutHeadFlag(two), { status: 'flagged', issues: ['off-topic — the picture does not show what this post is about'] });
  const clean = { status: 'approved', issues: [] };
  assert.equal(withoutHeadFlag(clean), clean, 'untouched when there is nothing to drop');
  assert.equal(withoutHeadFlag(null), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { alreadyQueuedMessage, hasGoneOut, networkOf, networksAlreadyPublished, networksAlreadyQueued } from './queue-guard.ts';

test('a network with a draft awaiting approval is skipped; the others go', () => {
  const posts = [
    { providers: ['linkedin'], status: 'pending_review' },
    { providers: ['YouTube'], status: 'scheduled' },
  ];
  const out = networksAlreadyQueued(posts, ['youtube', 'linkedin', 'tiktok']);
  assert.deepEqual(out.queued, ['youtube', 'linkedin']);
  assert.deepEqual(out.free, ['tiktok']);
});

test('an approved or published post no longer blocks its network', () => {
  const posts = [
    { providers: ['linkedin'], status: 'approved' },
    { providers: ['tiktok'], status: 'published' },
    { providers: ['youtube'], status: 'failed' },
  ];
  const out = networksAlreadyQueued(posts, ['linkedin', 'tiktok', 'youtube']);
  assert.deepEqual(out.queued, []);
  assert.deepEqual(out.free, ['linkedin', 'tiktok', 'youtube']);
});

test('no posts at all: everything is free', () => {
  assert.deepEqual(networksAlreadyQueued([], ['linkedin']), { queued: [], free: ['linkedin'] });
});

test('the network is the first provider, lowercased', () => {
  assert.equal(networkOf({ providers: ['LinkedIn', 'tiktok'] }), 'linkedin');
  assert.equal(networkOf({ providers: [] }), '');
  assert.equal(networkOf({}), '');
});

test('the message names the row when it is known', () => {
  assert.match(alreadyQueuedMessage('linkedin', '2026 CELLULAR HOPE · row 179'), /^2026 CELLULAR HOPE · row 179 already has a linkedin draft waiting/);
  assert.match(alreadyQueuedMessage('tiktok'), /^This video already has a tiktok draft/);
});

test('a network the video already went out on is finished, not free', () => {
  // Approving a row empties the waiting list, so the "already queued" rule
  // above saw nothing and the row looked free again — one press of Attach
  // videos over a range would have published the same reel twice.
  const posts = [
    { providers: ['linkedin'], status: 'published' },
    { providers: ['youtube'], status: 'approved' },
    { providers: ['tiktok'], status: 'failed' },
  ];
  const out = networksAlreadyPublished(posts, ['linkedin', 'youtube', 'tiktok']);
  assert.deepEqual(out.published, ['linkedin', 'youtube']);
  // A failed post is worth another attempt; a published one never is.
  assert.deepEqual(out.free, ['tiktok']);
});

test('gone out means approved, published, sent or live — nothing else', () => {
  for (const s of ['approved', 'published', 'Sent', 'LIVE']) assert.equal(hasGoneOut(s), true, String(s));
  for (const s of ['pending_review', 'scheduled', 'failed', 'rejected', '', null]) assert.equal(hasGoneOut(s), false, String(s));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAdoption, replaceMissing, type AdoptablePost } from './adopt-draft.ts';

const waiting = (network: string, over: Partial<AdoptablePost> = {}): AdoptablePost => ({
  id: 'post-' + network, metricool_post_id: 'mc-' + network,
  providers: [network], status: 'pending_review', ...over,
});

test('nothing waiting: the post is created, exactly as before', () => {
  assert.deepEqual(decideAdoption([], 'linkedin'), { action: 'create' });
  assert.deepEqual(decideAdoption([waiting('tiktok')], 'linkedin'), { action: 'create' });
});

test('a draft waiting on this network is the draft we continue', () => {
  // THE WALL, REMOVED. This used to be a 409 that stopped the send dead.
  assert.deepEqual(decideAdoption([waiting('linkedin')], 'linkedin'), {
    action: 'update', postId: 'post-linkedin', metricoolPostId: 'mc-linkedin',
  });
});

test('each network is decided on its own', () => {
  const posts = [waiting('linkedin'), waiting('youtube')];
  assert.equal(decideAdoption(posts, 'linkedin').action, 'update');
  assert.equal(decideAdoption(posts, 'youtube').action, 'update');
  assert.equal(decideAdoption(posts, 'tiktok').action, 'create');
});

test('published still refuses — even when a draft is waiting beside it', () => {
  // The one wall that stays. Sending again would publish the same reel twice,
  // and a waiting draft on the same network must not talk us out of that.
  for (const status of ['published', 'approved', 'sent', 'LIVE']) {
    assert.deepEqual(decideAdoption([waiting('linkedin', { status })], 'linkedin'), { action: 'refuse', reason: 'already_published' }, status);
  }
  assert.deepEqual(
    decideAdoption([waiting('linkedin', { id: 'a', status: 'published' }), waiting('linkedin', { id: 'b' })], 'linkedin'),
    { action: 'refuse', reason: 'already_published' },
  );
});

test('a failed or rejected attempt is worth another go, not an update', () => {
  for (const status of ['failed', 'rejected']) {
    assert.deepEqual(decideAdoption([waiting('linkedin', { status })], 'linkedin'), { action: 'create' }, status);
  }
});

test('a waiting row that never reached Metricool is created, never a silent no-op', () => {
  // No metricool_post_id means there is nothing to replace. Reporting success
  // and changing nothing anywhere is the worst of the three outcomes.
  for (const missing of [null, '', undefined]) {
    assert.deepEqual(decideAdoption([waiting('linkedin', { metricool_post_id: missing })], 'linkedin'), { action: 'create' }, String(missing));
  }
  assert.deepEqual(decideAdoption([waiting('linkedin', { id: '' })], 'linkedin'), { action: 'create' });
});

test('the network is matched case-insensitively, and an empty one creates', () => {
  assert.equal(decideAdoption([waiting('linkedin')], 'LinkedIn').action, 'update');
  assert.equal(decideAdoption([{ ...waiting('linkedin'), providers: ['LinkedIn'] }], 'linkedin').action, 'update');
  assert.deepEqual(decideAdoption([waiting('linkedin')], '  '), { action: 'create' });
});

test('only "the draft is gone" is retried as a create', () => {
  assert.equal(replaceMissing(404), true, 'Metricool has no post with that id');
  assert.equal(replaceMissing(410), true, 'it had one, and it is gone');
});

test('nothing else is — that is how duplicates get made', () => {
  // A rejected body, a refused credential, a rate limit or an outage all leave
  // the post very possibly still there. Creating a second one on any of these
  // would manufacture the exact duplicate the adoption rule exists to prevent.
  for (const code of [200, 201, 400, 401, 403, 409, 422, 429, 500, 502, 503]) {
    assert.equal(replaceMissing(code), false, String(code));
  }
  for (const junk of [null, undefined, '', 'not found', NaN, {}]) {
    assert.equal(replaceMissing(junk), false, String(junk));
  }
});

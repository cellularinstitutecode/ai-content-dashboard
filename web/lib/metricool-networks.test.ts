// web/lib/metricool-networks.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MC_NETWORKS, isMetricoolNetwork, metricoolNetworks, otherChannels, wantsBlog } from './metricool-networks.ts';

test('blog is not a Metricool network, and never was', () => {
  // THE BUG THIS EXISTS FOR. The templates UI offers `blog` as a channel
  // alongside Instagram, two routes cast the raw column to Provider[] with no
  // filter, and one bad entry can fail the whole multi-network call.
  assert.equal(isMetricoolNetwork('blog'), false);
  assert.deepEqual(metricoolNetworks(['blog', 'instagram', 'facebook']), ['instagram', 'facebook']);
  assert.deepEqual(otherChannels(['blog', 'instagram']), ['blog']);
  assert.equal(wantsBlog(['blog', 'instagram']), true);
  assert.equal(wantsBlog(['instagram']), false);
});

test('the ten are the ten', () => {
  assert.equal(MC_NETWORKS.length, 10);
  for (const n of MC_NETWORKS) assert.equal(isMetricoolNetwork(n), true, n);
  assert.equal(new Set(MC_NETWORKS).size, MC_NETWORKS.length, 'no duplicates');
});

test('the caller\'s order is kept, because the first entry picks the copy', () => {
  // approveRun sends the variant belonging to the first network, so reordering
  // this list would quietly change which copy goes out.
  assert.deepEqual(metricoolNetworks(['linkedin', 'instagram']), ['linkedin', 'instagram']);
  assert.deepEqual(metricoolNetworks(['instagram', 'linkedin']), ['instagram', 'linkedin']);
});

test('the column is text[] filled in by clicking, so it is read defensively', () => {
  assert.deepEqual(metricoolNetworks(['  Instagram  ', 'FACEBOOK']), ['instagram', 'facebook']);
  assert.deepEqual(metricoolNetworks(['instagram', 'instagram']), ['instagram'], 'deduplicated');
  assert.deepEqual(metricoolNetworks(null), []);
  assert.deepEqual(metricoolNetworks(undefined), []);
  assert.deepEqual(metricoolNetworks('instagram'), [], 'a string is not a list');
  assert.deepEqual(metricoolNetworks([null, 42, {}, 'instagram']), ['instagram']);
  assert.deepEqual(otherChannels([null, '', '  ', 'blog']), ['blog'], 'empties are not channels');
});

test('an unrecognised channel is not silently sent to Metricool', () => {
  // A network added to the UI before it is added here must not arrive at
  // Metricool as an unknown provider and fail the call for the others.
  assert.deepEqual(metricoolNetworks(['instagram', 'mastodon']), ['instagram']);
  assert.deepEqual(otherChannels(['instagram', 'mastodon']), ['mastodon']);
});

// Unit tests for the tick-after-prepare rule. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOutcomes, networksToAdd } from './tick-add.ts';

const sent = (network: string) => ({ network, ok: true });
const refused = (network: string, reason: string) => ({ network, ok: false, reason });

test('a network already sent is not sent again', () => {
  const prior = [sent('youtube'), sent('linkedin'), sent('tiktok')];
  assert.deepEqual(networksToAdd(['youtube', 'linkedin', 'tiktok'], prior), []);
  assert.deepEqual(networksToAdd(['youtube', 'linkedin', 'tiktok', 'facebook'], prior), ['facebook']);
});

test('a network the hand-off already answered as queued or published counts as done', () => {
  const prior = [sent('linkedin'), refused('youtube', 'already_published'), refused('tiktok', 'already_queued')];
  assert.deepEqual(networksToAdd(['youtube', 'linkedin', 'tiktok', 'twitter'], prior), ['twitter']);
});

test('a network refused for another reason is asked for again', () => {
  const prior = [sent('linkedin'), refused('twitter', 'too_long'), refused('youtube', 'upload_pending')];
  assert.deepEqual(networksToAdd(['twitter', 'youtube', 'linkedin'], prior), ['twitter', 'youtube']);
});

test('no record at all means every tick is new', () => {
  assert.deepEqual(networksToAdd(['facebook', 'instagram'], null), ['facebook', 'instagram']);
  assert.deepEqual(networksToAdd(['facebook', 'instagram'], []), ['facebook', 'instagram']);
});

test('email is a column, not a network; case and duplicates are folded', () => {
  // The sheet's X column arrives as Metricool's id, 'twitter' (lib/sheet-ticks.ts).
  assert.deepEqual(networksToAdd(['Email', 'FACEBOOK', 'facebook', 'twitter'], [sent('TWITTER')]), ['facebook']);
  assert.deepEqual(networksToAdd([], [sent('linkedin')]), []);
});

test('this pass’s answers replace the old ones for the same networks and keep the rest', () => {
  const prior = [sent('linkedin'), refused('facebook', 'metricool_error')];
  const made = [sent('facebook'), refused('twitter', 'too_long')];
  assert.deepEqual(mergeOutcomes(prior, made), [sent('linkedin'), sent('facebook'), refused('twitter', 'too_long')]);
  assert.deepEqual(mergeOutcomes(null, made), made);
});

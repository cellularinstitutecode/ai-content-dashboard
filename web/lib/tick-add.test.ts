// Unit tests for the tick-after-prepare rule. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenSlot, mergeOutcomes, networksToAdd } from './tick-add.ts';

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

test('a requested time is used as given when nothing is scheduled on it', () => {
  process.env.VIDEO_POST_DAYS = 'all';
  const now = new Date('2026-10-27T15:00:00Z');
  const asked = new Date('2026-11-03T18:00:00Z');
  const c = chosenSlot(asked, ['2026-11-03T22:00:00Z'], now);
  assert.equal(c.ok, true);
  if (c.ok) { assert.equal(c.at.toISOString(), asked.toISOString()); assert.equal(c.moved, false); }
});

test('a requested time already taken moves to the next free grid slot after it, and says so', () => {
  process.env.VIDEO_POST_DAYS = 'all';
  delete process.env.VIDEO_AUTOPILOT_TIMES;
  const now = new Date('2026-10-27T15:00:00Z');
  // 13:00 Cancún (18:00Z) is taken; the next grid slot is 17:00 Cancún (22:00Z) the same day.
  const c = chosenSlot(new Date('2026-11-03T18:00:00Z'), ['2026-11-03T18:00:00Z'], now);
  assert.equal(c.ok, true);
  if (c.ok) { assert.equal(c.at.toISOString(), '2026-11-03T22:00:00.000Z'); assert.equal(c.moved, true); }
});

test('a time already gone, or no time at all, is refused as past', () => {
  const now = new Date('2026-10-27T15:00:00Z');
  assert.deepEqual(chosenSlot(new Date('2026-10-27T14:59:00Z'), [], now), { ok: false, reason: 'past' });
  assert.deepEqual(chosenSlot(new Date('2026-10-27T15:00:00Z'), [], now), { ok: false, reason: 'past' });
  assert.deepEqual(chosenSlot(new Date('not a date'), [], now), { ok: false, reason: 'past' });
});

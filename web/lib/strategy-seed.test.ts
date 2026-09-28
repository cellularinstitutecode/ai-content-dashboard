// web/lib/strategy-seed.test.ts
//
// The seed writes to a table with no unique key, so the thing worth testing
// hardest is the second press: fifteen templates must stay fifteen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOG_SLOT,
  SEED_MARK,
  STRATEGY_PROVIDERS,
  isSeeded,
  matchKey,
  planSeed,
  seedRows,
  seedSummary,
} from './strategy-seed.ts';

/** What the account looks like after a successful press. */
const asSeeded = () => seedRows().map((r, i) => ({ id: 'id-' + i, name: r.name, strategy: r.strategy, weekdays: r.weekdays, time_of_day: r.time_of_day }));

/** A row the seed wrote before slot keys existed: the mark, no slot. */
const legacyMark = () => {
  const { slot: _slot, pillarId: _pillarId, ...rest } = seedRows()[0].strategy;
  void _slot; void _pillarId;
  return rest;
};
import { POSTS_PER_WEEK } from './content-strategy.ts';

/** Fourteen social slots plus the weekly article. */
const SLOTS = POSTS_PER_WEEK + 1;

test('fourteen social rows plus the article, each pinned to one day', () => {
  const rows = seedRows();
  assert.equal(rows.length, SLOTS);
  const social = rows.filter((r) => r.strategy.format === 'social');
  assert.equal(social.length, POSTS_PER_WEEK);
  for (const r of social) {
    assert.equal(r.weekdays.length, 1, r.name + ' must stay a one-day template');
    assert.equal(r.strategy.mode, 'pillars');
    assert.ok(r.strategy.pillars.length >= 5, r.name + ' must carry its whole angle bank');
    assert.deepEqual(r.providers, [...STRATEGY_PROVIDERS]);
    assert.equal(r.active, true);
    assert.match(r.time_of_day, /^(09:00|18:00)$/);
    assert.equal(r.id, undefined, 'a fresh row carries no id');
  }
  // Not TikTok or YouTube (they refuse a post with no video) and not blog
  // (an article is its own slot).
  assert.ok(!STRATEGY_PROVIDERS.includes('tiktok'));
  assert.ok(!STRATEGY_PROVIDERS.includes('youtube'));
  assert.ok(!STRATEGY_PROVIDERS.includes('blog'));
});

test('the two standing rules survive the trip into the row', () => {
  // These are the document's only two rules that are not about a day. They had
  // nowhere to live before lib/content-strategy.ts, and nowhere to land before
  // strategy.rule — so this is the assertion that keeps them attached.
  const withRule = seedRows().filter((r) => r.strategy.rule);
  // Thursday's Cancun post, Friday's recovery post, and Sunday's recovery in
  // Cancun — which carries both notes, as the frequency table counts it twice.
  assert.equal(withRule.length, 3);
  const text = withRule.map((r) => r.strategy.rule).join('\n');
  assert.match(text, /Never claim that Cancun is categorically better/);
  assert.match(text, /INTRODUCED here and never promoted/);
});

test('a first press creates everything and updates nothing', () => {
  const plan = planSeed([]);
  assert.equal(plan.create.length, SLOTS);
  assert.equal(plan.update.length, 0);
  assert.deepEqual(plan.duplicates, []);
});

test('a second press updates in place — fifteen stays fifteen', () => {
  // THE POINT OF THIS FILE. schedule_templates has no unique key, so without
  // this the button is a way to double the calendar every time it is pressed.
  const plan = planSeed(asSeeded());
  assert.equal(plan.create.length, 0);
  assert.equal(plan.update.length, SLOTS);
  for (const row of plan.update) assert.match(row.id || '', /^id-\d+$/, 'an update must carry the id it replaces');
});

test('somebody else\'s templates are never claimed, renamed or touched', () => {
  const mine = [
    { id: 'a', name: 'Monday promo — knees' },
    { id: 'b', name: 'Newsletter teaser' },
    { id: 'c', name: '' },
    { id: '', name: 'Nutrition', strategy: seedRows()[0].strategy },
  ];
  const plan = planSeed(mine);
  // The id-less row cannot be addressed, so Nutrition is created alongside
  // rather than written over something this seed cannot address.
  assert.equal(plan.create.length, SLOTS);
  assert.equal(plan.update.length, 0);
  const ids = plan.update.map((r) => r.id);
  assert.ok(!ids.includes('a') && !ids.includes('b') && !ids.includes('c'));
});

test('matching ignores case and spacing on rows the seed owns', () => {
  const mark = legacyMark();
  const existing = [
    { id: 'x', name: '  nutrition  ', strategy: mark },
    { id: 'y', name: 'SLEEP', strategy: mark },
  ];
  const plan = planSeed(existing);
  assert.equal(plan.update.length, 2);
  assert.deepEqual(plan.update.map((r) => r.id).sort(), ['x', 'y']);
  assert.equal(plan.create.length, SLOTS - 2);
  assert.equal(matchKey('  Two   Words '), 'two words');
  assert.equal(matchKey(null), '');
});

test('a template the seed did not write is NEVER overwritten, whatever it is called', () => {
  // THE ONE THAT NEARLY COST SOMEBODY THEIR WORK. The seed's names are
  // ordinary words. Matching on name alone meant a template a person had
  // written and called "Nutrition" was absorbed on the first press — channels,
  // days, time and strategy replaced, text emptied — while the confirm dialog
  // promised their templates would be left alone.
  const mine = [
    { id: 'mine', name: 'Nutrition', strategy: { mode: 'fixed_topic', topic: 'my own thing' } },
    { id: 'plain', name: 'Sleep' },
    { id: 'nostrategy', name: 'Recovery', strategy: null },
  ];
  const plan = planSeed(mine);
  assert.equal(plan.update.length, 0, 'nothing of theirs is updated');
  assert.equal(plan.create.length, SLOTS, 'the slots are created alongside');
  // And the collision is reported rather than discovered on the calendar.
  assert.deepEqual(plan.collisions.sort(), ['Nutrition', 'Recovery', 'Sleep']);
  assert.match(seedSummary(plan), /You already have a template called/);
  assert.match(seedSummary(plan), /NOT touched/);
});

test('the mark is what makes a row ours, and it survives a round trip', () => {
  for (const row of seedRows()) assert.equal(row.strategy.seeded, SEED_MARK);
  assert.equal(isSeeded({ strategy: { seeded: SEED_MARK } }), true);
  assert.equal(isSeeded({ strategy: { seeded: 'something else' } }), false);
  assert.equal(isSeeded({ strategy: { mode: 'pillars' } }), false);
  assert.equal(isSeeded({ strategy: null }), false);
  assert.equal(isSeeded({}), false);
  assert.equal(isSeeded(undefined), false);
});

test('a duplicated name updates the first and says so about the rest', () => {
  // Deleting the extra would be this seed removing somebody's work. Saying
  // nothing would leave two posts in one slot with no explanation.
  const mark = legacyMark();
  const plan = planSeed([
    { id: 'first', name: 'Prevention', strategy: mark },
    { id: 'second', name: 'prevention', strategy: mark },
  ]);
  assert.deepEqual(plan.duplicates, ['Prevention']);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].id, 'first');
  assert.match(seedSummary(plan), /more than one slot named "Prevention"/);
  assert.match(seedSummary(plan), /left alone/);
});

test('the summary is a sentence, not a pair of numbers', () => {
  assert.match(seedSummary(planSeed([])), /^15 slots added — fourteen posts a week, two a day/);
  assert.match(seedSummary(planSeed([])), /plus the Monday article on WordPress, promoted on Facebook and LinkedIn/);
  assert.match(seedSummary(planSeed([])), /waiting in the review queue\.$/);
  const second = seedSummary(planSeed(asSeeded()));
  assert.match(second, /15 brought up to date/);
  assert.match(second, /review queue/, 'it must say that nothing publishes from this');
});

test('the weekly article leads the week, and carries its promos with it', () => {
  // Monday, because that is the day the strategy gives to its two medical
  // pillars — so the long read and the week's short posts circle the same
  // territory. 11:00, because 08:00 and 17:00 are the reels and 09:00 and
  // 18:00 are Monday's own social slots.
  const article = seedRows().find((r) => r.strategy.format === 'blog');
  assert.ok(article, 'the weekly article is gone');
  assert.deepEqual(article!.weekdays, [1]);
  assert.equal(article!.time_of_day, '11:00');
  assert.equal(article!.name, BLOG_SLOT.name);
  for (const clash of ['08:00', '17:00', '09:00', '18:00']) {
    assert.notEqual(article!.time_of_day, clash);
  }
  // One pack, three destinations: the article to WordPress and a promo
  // carrying its link on the two networks where a link works. Not Instagram:
  // that made fifteen Instagram posts a week where the strategy asks fourteen.
  assert.deepEqual(article!.providers, ['blog', 'facebook', 'linkedin']);
  assert.ok(!article!.providers.includes('instagram'));
  assert.ok(article!.strategy.pillars.length >= 5, 'it rotates like every other slot');
  assert.equal(new Set(article!.strategy.pillars).size, article!.strategy.pillars.length);
});

test('only one slot publishes an article', () => {
  // Fifteen posts a week is the calendar. Two articles would be a different
  // decision, taken by editing this file rather than by accident.
  assert.equal(seedRows().filter((r) => r.providers.includes('blog')).length, 1);
  assert.equal(seedRows().filter((r) => r.strategy.format === 'blog').length, 1);
});

test('a re-seed changes only what the document owns: edits and pauses survive', () => {
  // Pressing the button again used to rewrite the whole row: a slot moved to
  // 10:00 went back to 09:00, a paused slot was switched back on, and the
  // channels were reset.
  const existing = asSeeded().map((r) => ({ ...r }));
  const nutrition = existing.find((r) => r.name === 'Nutrition')!;
  nutrition.time_of_day = '10:30';
  (nutrition as Record<string, unknown>).active = false;
  (nutrition.strategy as Record<string, unknown>) = { ...nutrition.strategy, goal: 'engagement', lead_hours: 48, pillars: ['stale'] };
  const plan = planSeed(existing);
  assert.equal(plan.create.length, 0);
  const u = plan.update.find((r) => r.id === nutrition.id)!;
  // Only the strategy is in an update at all — no time, no active, no providers.
  assert.deepEqual(Object.keys(u).sort(), ['id', 'name', 'strategy']);
  assert.equal(u.strategy.goal, 'engagement', 'the operator\'s goal is kept');
  assert.equal(u.strategy.lead_hours, 48, 'and their lead time');
  assert.ok((u.strategy.pillars as string[]).length >= 5, 'the document\'s bank is restored');
  assert.equal(u.strategy.slot, 'tue-1');
  assert.equal(u.strategy.pillarId, 'nutrition');
});

test('a renamed slot is recognised by its key, not duplicated', () => {
  const existing = asSeeded();
  existing.find((r) => r.name === 'Nutrition')!.name = 'Nutrition (Tuesday AM)';
  const plan = planSeed(existing);
  assert.equal(plan.create.length, 0, 'no second Tuesday nutrition slot');
  assert.equal(plan.update.length, SLOTS);
  assert.ok(plan.update.some((u) => u.name === 'Nutrition (Tuesday AM)'), 'reported under the name it has now');
});

test('a legacy row renamed before slot keys existed is found by its day and time', () => {
  const mark = legacyMark();
  const plan = planSeed([{ id: 'old', name: 'Tuesday food', strategy: { ...mark, format: 'social' }, weekdays: [2], time_of_day: '09:00:00' }]);
  const u = plan.update.find((r) => r.id === 'old');
  assert.ok(u, 'matched');
  assert.equal(u!.strategy.slot, 'tue-1');
  assert.equal(plan.create.length, SLOTS - 1);
});

test('every seeded row carries its slot key and pillar', () => {
  const rows = seedRows();
  const keys = rows.map((r) => r.strategy.slot);
  assert.equal(new Set(keys).size, rows.length, 'keys are unique');
  assert.ok(keys.includes('mon-blog'));
  for (const r of rows.filter((x) => x.strategy.format === 'social')) assert.ok(r.strategy.pillarId, r.name);
});

test('an article row still on the seed\'s old channel list moves off Instagram; a hand-set one does not', async () => {
  const { LEGACY_BLOG_PROVIDERS } = await import('./strategy-seed.ts');
  const rows = asSeeded().map((r) => ({ ...r, providers: r.strategy.format === 'blog' ? [...LEGACY_BLOG_PROVIDERS] : ['instagram', 'facebook', 'linkedin'] }));
  const u = planSeed(rows).update.find((x) => x.strategy.slot === 'mon-blog')!;
  assert.deepEqual(u.providers, ['blog', 'facebook', 'linkedin']);
  const mine = asSeeded().map((r) => ({ ...r, providers: r.strategy.format === 'blog' ? ['blog', 'linkedin'] : ['instagram'] }));
  const kept = planSeed(mine).update.find((x) => x.strategy.slot === 'mon-blog')!;
  assert.equal(kept.providers, undefined, 'a list somebody chose is theirs');
  assert.ok(planSeed(rows).update.filter((x) => x.providers).length === 1, 'no other row has its channels touched');
});

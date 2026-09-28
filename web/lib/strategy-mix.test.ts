import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOG_SLOT_KEY, WEEKLY_MIX, mixByPillarDays } from './content-strategy.ts';
import { seedRows } from './strategy-seed.ts';
import { frequencyRange, nextOccurrence, plannedMix, slotLabel, type MixTemplate } from './strategy-mix.ts';

const seeded = () => seedRows().map((r, i) => ({ ...r, id: 't' + i }));

test('the frequency column reads as a range', () => {
  assert.deepEqual(frequencyRange('2x weekly'), { min: 2, max: 2 });
  assert.deepEqual(frequencyRange('1x weekly'), { min: 1, max: 1 });
  assert.deepEqual(frequencyRange('1-2x weekly'), { min: 1, max: 2 });
  assert.equal(frequencyRange('often'), null);
});

test('the seeded week meets every row of the frequency table', () => {
  const mix = plannedMix(seeded());
  for (const r of mix.rows) assert.equal(r.status, 'ok', r.name + ': ' + r.planned + ' vs ' + r.frequency);
  assert.deepEqual(mix.missing, []);
  assert.deepEqual(mix.paused, []);
  assert.equal(mix.article, 'on');
  // Both of the document's numbers are shown, not reconciled.
  for (const [g, v] of Object.entries(mix.groups)) {
    assert.equal(v.recommended, WEEKLY_MIX[g as keyof typeof WEEKLY_MIX]);
    assert.equal(v.dayMap, mixByPillarDays()[g as keyof typeof WEEKLY_MIX]);
    assert.equal(v.planned, v.dayMap, g + ': the seeded week IS the day map');
  }
});

test('pausing or removing a slot shows up as the row it leaves short', () => {
  const rows: MixTemplate[] = seeded().map((r) => (r.strategy.slot === 'wed-2' ? { ...r, active: false } : r));
  const withoutThu2 = rows.filter((r) => r.strategy?.slot !== 'thu-2');
  const mix = plannedMix(withoutThu2);
  assert.deepEqual(mix.paused, ['wed-2']);
  assert.deepEqual(mix.missing, ['thu-2']);
  assert.equal(mix.rows.find((r) => r.id === 'sleep-stress')!.status, 'under');
  assert.equal(mix.rows.find((r) => r.id === 'cancun')!.status, 'under');
  assert.equal(mix.groups.cancun.planned, 1);
});

test('a slot scheduled on a second day counts twice, and can go over', () => {
  const rows = seeded().map((r) => (r.strategy.slot === 'tue-2' ? { ...r, weekdays: [2, 4] } : r));
  const supp = plannedMix(rows).rows.find((r) => r.id === 'supplementation')!;
  assert.equal(supp.planned, 2);
  assert.equal(supp.status, 'over');
});

test('the article is reported on its own, and templates without a slot are ignored', () => {
  const rows = seeded().filter((r) => r.strategy.slot !== BLOG_SLOT_KEY);
  const mix = plannedMix([...rows, { id: 'x', active: true, weekdays: [1], strategy: {} }]);
  assert.equal(mix.article, 'missing');
  assert.deepEqual(mix.missing, []);
});

test('nextOccurrence previews the engine\'s own deal', () => {
  const rows = seeded();
  const mon1 = rows.find((r) => r.strategy.slot === 'mon-1')!;
  // Sunday 2026-10-04 12:00 Cancún: the next Monday 09:00 is in week 1.
  const next = nextOccurrence(mon1, new Date('2026-10-04T17:00:00Z'));
  assert.ok(next && next.angle, JSON.stringify(next));
  if (next && next.angle) {
    assert.equal(next.at, '2026-10-05T14:00:00.000Z');
    assert.ok(mon1.strategy.pillars.includes(next.angle));
    assert.ok(next.position >= 1 && next.position <= next.of);
    assert.ok(next.format && next.audience, 'a social slot shows its caption shape and reader');
  }
  const blog = rows.find((r) => r.strategy.slot === BLOG_SLOT_KEY)!;
  const art = nextOccurrence(blog, new Date('2026-10-04T17:00:00Z'));
  assert.ok(art && art.angle);
  assert.ok(art && art.angle && !('format' in art && art.format), 'the article is not dealt a caption shape');
});

test('nextOccurrence says why when it cannot preview', () => {
  const mon1 = seeded().find((r) => r.strategy.slot === 'mon-1')!;
  const edited = { ...mon1, strategy: { ...mon1.strategy, pillars: ['My own angle'] } };
  const e = nextOccurrence(edited, new Date('2026-10-04T17:00:00Z'));
  assert.equal(e && e.angle, null);
  assert.equal(e && 'reason' in e && e.reason, 'edited');
  const early = nextOccurrence(mon1, new Date('2026-09-01T17:00:00Z'));
  assert.equal(early && 'reason' in early && early.reason, 'before-start');
  assert.equal(nextOccurrence({ weekdays: [1], strategy: {} }), null, 'not a strategy slot');
  assert.equal(slotLabel('wed-2'), 'Wednesday · Sleep and rest');
});

test('only slots the engine rotates are measured or previewed: a slot key without the seed mark is not', () => {
  const mon1 = seeded().find((r) => r.strategy.slot === 'mon-1')!;
  const unseeded = { ...mon1, strategy: { ...mon1.strategy, seeded: undefined } };
  assert.equal(nextOccurrence(unseeded, new Date('2026-10-04T17:00:00Z')), null);
  const mix = plannedMix([...seeded().filter((r) => r.strategy.slot !== 'mon-1'), unseeded]);
  assert.deepEqual(mix.missing, ['mon-1']);
});

test('nextOccurrence follows the zone it is given', () => {
  const mon1 = seeded().find((r) => r.strategy.slot === 'mon-1')!;
  const now = new Date('2026-10-04T17:00:00Z');
  const cancun = nextOccurrence(mon1, now, 'America/Cancun');
  const madrid = nextOccurrence(mon1, now, 'Europe/Madrid');
  assert.equal(cancun && cancun.at, '2026-10-05T14:00:00.000Z');
  assert.equal(madrid && madrid.at, '2026-10-05T07:00:00.000Z', '09:00 in the configured zone');
});

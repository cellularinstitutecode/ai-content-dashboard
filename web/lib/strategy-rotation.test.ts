import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STRATEGY_EPOCH,
  angleFor,
  bankIsDocument,
  dealtWeek,
  deckFor,
  keyWords,
  rotationSlots,
  siblingAngles,
  weekIndex,
} from './strategy-rotation.ts';
import { BLOG_ANGLES } from './strategy-seed.ts';

const WEEKS = 60;
const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('no two slots ever write the same angle in the same week — the article included', () => {
  // The article's bank was six of Monday's and Thursday's bullets, word for
  // word, so in the first week it always wrote Monday's first post again.
  for (let w = 0; w < WEEKS; w++) {
    const angles = Object.values(dealtWeek(w));
    assert.equal(angles.length, 15, 'fourteen posts and the article, week ' + w);
    assert.equal(new Set(angles).size, angles.length, 'a shared angle in week ' + w);
  }
});

test('a slot never writes last week\'s angle, and uses its whole bank every cycle', () => {
  for (const key of rotationSlots()) {
    const deck = deckFor(key);
    for (let w = 1; w < WEEKS; w++) assert.notEqual(dealtWeek(w)[key], dealtWeek(w - 1)[key], key + ' repeated in week ' + w);
    if (key === 'mon-blog') continue;
    for (let start = 0; start + deck.length <= WEEKS; start += deck.length) {
      const cycle = new Set(Array.from({ length: deck.length }, (_, i) => dealtWeek(start + i)[key]));
      assert.equal(cycle.size, deck.length, key + ' did not use its whole bank in weeks ' + start + '-' + (start + deck.length - 1));
    }
  }
  // The article runs through all four medical banks before any angle comes back.
  const article = new Set(Array.from({ length: 22 }, (_, i) => dealtWeek(i)['mon-blog']));
  assert.equal(article.size, 22);
});

test('the near-duplicates the old rotation paired up never land in the same week', () => {
  // Index k of every bank used to fall in the same week, so these came out
  // together every five or six weeks.
  const PAIRS: [string, string][] = [
    ['The role of protein in recovery', 'Protein-rich breakfast ideas'],
    ['Why staying active matters at every age', 'Simple activities that help people stay active'],
    ['Why the body needs time to respond', 'Why the body needs intentional rest'],
    ['Hydration and cellular health', 'Hydration, rest, and movement after treatment'],
    ['Recovering in a calm, warm environment', 'Nature, the beach, and a calmer pace'],
    ['How to begin moving when pain or limited mobility is present', 'Options when intense exercise is not appropriate'],
    ['Why similar symptoms may have different causes', 'The difference between addressing symptoms and exploring possible causes'],
    ['Why effective care begins with a thorough evaluation', 'The value of periodic health evaluations'],
    ['Muscle strength and longevity', 'Maintaining muscle mass after 40, 50, or 60'],
    ['Ways to incorporate movement while traveling', 'How to make balanced choices while traveling'],
  ];
  for (let w = 0; w < WEEKS; w++) {
    const angles = new Set(Object.values(dealtWeek(w)));
    for (const [a, b] of PAIRS) assert.ok(!(angles.has(a) && angles.has(b)), 'week ' + w + ': ' + a + ' / ' + b);
  }
});

test('the schedule is a pure function of the week', () => {
  const first = JSON.stringify(dealtWeek(37));
  assert.equal(JSON.stringify(dealtWeek(37)), first);
  assert.equal(Object.keys(dealtWeek(0)).length, 15);
});

test('weeks are counted from the epoch Monday in the clinic\'s zone, not by counting runs', () => {
  const tz = 'America/Cancun';
  assert.equal(STRATEGY_EPOCH, '2026-09-28');
  assert.equal(weekIndex('2026-09-28T14:00:00Z', tz), 0, 'Monday 09:00 Cancun');
  assert.equal(weekIndex('2026-10-04T23:00:00Z', tz), 0, 'Sunday 18:00 Cancun is the same week');
  assert.equal(weekIndex('2026-10-05T14:00:00Z', tz), 1);
  assert.equal(weekIndex('2026-09-27T23:00:00Z', tz), -1, 'the Sunday before the epoch');
  // A Sunday 18:00 slot is 23:00Z — Monday's date nowhere, Sunday in Cancun.
  assert.equal(weekIndex('2026-10-05T01:00:00Z', tz), 0, 'Sunday 20:00 Cancun is still week 0');
});

test('only the document\'s own bank is dealt; an edited bank keeps the old rotation', () => {
  assert.equal(bankIsDocument('tue-1', deckFor('tue-1')), true);
  assert.equal(bankIsDocument('tue-1', [...deckFor('tue-1'), 'An angle somebody added']), false);
  assert.equal(bankIsDocument('mon-blog', [...BLOG_ANGLES], [...BLOG_ANGLES]), true);
  assert.equal(angleFor('tue-1', '2026-10-06T14:00:00Z', { bank: ['my own'] }), null);
  assert.equal(angleFor('tue-1', '2026-09-22T14:00:00Z', { bank: deckFor('tue-1') }), null, 'before the epoch');
  const a = angleFor('tue-1', '2026-10-06T14:00:00Z', { bank: deckFor('tue-1'), tz: 'America/Cancun' });
  assert.equal(a?.angle, dealtWeek(1)['tue-1']);
  assert.equal(a?.of, 6);
});

test('the switch-over does not republish what a slot just published', () => {
  const scheduled = dealtWeek(0)['tue-1'];
  const a = angleFor('tue-1', '2026-09-29T14:00:00Z', { bank: deckFor('tue-1'), avoid: [scheduled], tz: 'America/Cancun' });
  assert.ok(a);
  assert.notEqual(a!.angle, scheduled);
  assert.ok(!Object.entries(dealtWeek(0)).some(([k, v]) => k !== 'tue-1' && v === a!.angle), 'and not another slot\'s angle either');
});

test('siblings are the slots sharing a row of the frequency table', () => {
  const week = dealtWeek(3);
  assert.deepEqual(siblingAngles('tue-1', 3), [week['sat-2']], 'Tuesday nutrition ↔ Saturday practical nutrition');
  assert.deepEqual(siblingAngles('sun-2', 3).sort(), [week['thu-2'], week['fri-2']].sort(), 'recovery and Cancun');
  assert.equal(siblingAngles('mon-blog', 3).length, 4);
  assert.ok(keyWords('Why staying active matters').has('stay'));
});

test('wiring: stepResearch takes a seeded slot\'s angle from the dealt schedule', () => {
  const ap = src('lib/autopilot.ts');
  const research = ap.slice(ap.indexOf('async function stepResearch('), ap.indexOf('const GOAL_INSTRUCTION'));
  assert.match(research, /dealt = angleFor\(strategy\.slot, run\.scheduled_for, \{/);
  assert.match(research, /if \(dealt\) seedTopic = dealt\.angle;/);
  const dealtAt = research.indexOf('dealt = angleFor(');
  const bundleAt = research.indexOf('await researchBundle(seedTopic');
  assert.ok(dealtAt > 0 && bundleAt > dealtAt, 'the research is done on the dealt angle');
});

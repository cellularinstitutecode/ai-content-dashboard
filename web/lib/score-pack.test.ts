import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentWords, scorePack } from './score-pack.ts';

const REF = '\n\nREF: Smith, A. (2020). "Sleep." J Sleep. DOI: 10.1000/x';
const body = (s: string) => s + ' '.repeat(0) + '\nSave this for tonight.' + REF;

test('a strategy post covering the angle in its own words gets full keyword marks', () => {
  const angle = { query: 'Why sleeping longer does not always mean resting better' };
  const own = { instagram: body('Eight hours in bed is not the same as rest. Quality matters more than length: deep, unbroken sleep is when repair happens, and resting well depends on rhythm, light and calm evenings. Longer nights alone rarely fix fatigue.') };
  const s = scorePack(own as never, ['instagram'], angle, { strategySlot: true });
  assert.equal(s.breakdown.keyword, 30);
  assert.ok(!s.critique.some((c) => /exact phrase/.test(c)), 'never told to paste the sentence in');
});

test('a strategy post off the angle is told to cover it in its own words', () => {
  const angle = { query: 'Why sleeping longer does not always mean resting better' };
  const off = { instagram: body('Protein at breakfast keeps energy steady through the morning, and a glass of water helps too. Start with eggs or yoghurt.') };
  const s = scorePack(off as never, ['instagram'], angle, { strategySlot: true });
  assert.ok(s.breakdown.keyword < 18);
  assert.ok(s.critique.some((c) => /in your own words; do not copy the sentence/.test(c)));
});

test('a strategy post earns CTA points only for the gentle next step', () => {
  const angle = { query: 'sleep quality' };
  const sales = scorePack({ instagram: 'Sleep quality matters for everyone reading this post today, truly it does. Book your visit today.' + REF } as never, ['instagram'], angle, { strategySlot: true });
  assert.equal(sales.breakdown.cta, 0);
  assert.ok(sales.promotionFlags?.includes('booking call to action'));
  const soft = scorePack({ instagram: body('Sleep quality matters for everyone reading this post today, truly it does, and here is why.') } as never, ['instagram'], angle, { strategySlot: true });
  assert.equal(soft.breakdown.cta, 15);
});

test('other templates keep the search-phrase rubric', () => {
  const s = scorePack({ instagram: 'Stem cell therapy in Cancun explained. Book a consult.' } as never, ['instagram'], { query: 'stem cell therapy cancun' });
  assert.equal(s.breakdown.keyword, 30);
  assert.equal(s.breakdown.cta, 15);
  assert.equal(s.promotionFlags, undefined);
});

test('content words drop the filler', () => {
  assert.deepEqual(contentWords('Why the body needs time to respond'), ['needs', 'time', 'respond']);
});

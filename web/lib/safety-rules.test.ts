import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanContent, reviewPack, negatedAt } from './safety-rules.ts';
import { PILLARS } from './content-strategy.ts';

const codes = (t: string) => scanContent(t).map((f) => f.code);

test('every angle in the written strategy scans clean', () => {
  // The document's own sentences are the floor: a rule that flags them flags
  // the posts written about them.
  for (const p of PILLARS) {
    assert.deepEqual(codes(p.name), [], p.name);
    for (const a of p.angles) assert.deepEqual(codes(a), [], a);
  }
});

test('responsible, hedged strategy copy is not a violation', () => {
  for (const t of [
    'Your physician reviews your history and diagnosis before recommending anything.',
    'If you have knee pain, start with gentle mobility work.',
    'Once you have your flights booked, plan a rest day.',
    'Do you have a plan for your trip?',
    'Supplements are support, not a cure. Results are not guaranteed.',
    'No protocol can guarantee identical outcomes.',
    "There's no miracle fix for poor sleep.",
    'Aim for about 20 g of protein at breakfast.',
    'A 500 ml glass of water with each meal is an easy habit.',
    'Take a 20-minute walk daily after dinner.',
    'Never self-medicate with supplements; talk it through with your physician.',
    "Don't try to diagnose yourself from a list of symptoms.",
  ]) {
    assert.deepEqual(codes(t), [], t);
  }
});

test('the REF and AVISO lines are not scanned as the post', () => {
  const post = 'Protein supports repair after treatment.\n\nREF: Smith, A. (2020). "Protein 1.6 g/kg in patients diagnosed with sarcopenia." J Nutr. DOI: 10.1000/xyz\n\nAVISO DE PUBLICIDAD: 2623022002A00090';
  assert.deepEqual(codes(post), []);
});

test('real violations still flag', () => {
  assert.ok(codes('This protocol cures arthritis.').includes('cure_claim'));
  assert.ok(codes('Results are guaranteed.').includes('cure_claim'));
  assert.ok(codes('Take 500 mg daily.').includes('dosing'));
  assert.ok(codes('Vitamin D above 1000 IU is best.').includes('dosing'));
  assert.ok(codes('Take two capsules every morning.').includes('dosing'));
  assert.ok(codes('Our doctors can diagnose it in one visit.').includes('diagnosis'));
  assert.ok(codes('You probably have a vitamin deficiency.').includes('diagnosis'));
  assert.ok(codes('Try to self-diagnose first.').includes('diagnosis'));
  assert.ok(codes('Clinically proven to work.').includes('regulatory_claim'));
});

test('negation looks three words back, no further', () => {
  const t = 'This is not a cure';
  assert.equal(negatedAt(t, t.indexOf('cure')), true);
  const far = 'Not everyone agrees, but this is the cure';
  assert.equal(negatedAt(far, far.indexOf('cure')), false);
});

test('reviewPack dedupes across fields', () => {
  const flags = reviewPack({ instagram: 'It cures everything.', facebook: 'A guaranteed cure.', _image: { url: 'x' } });
  assert.deepEqual(flags.map((f) => f.code), ['cure_claim']);
});

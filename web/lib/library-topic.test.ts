// web/lib/library-topic.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REUSE_WINDOW_DAYS, pickFresh, pillarsForText, type LibraryCandidate } from './library-topic.ts';
import { BRAND_TARGET } from './palette.ts';

const cap = (subjects: string[], blockers: string[] = []) => ({ caption: 'x', subjects: subjects as never, blockers: blockers as never });
const photo = (id: string, subjects: string[], extra: Partial<LibraryCandidate> = {}): LibraryCandidate =>
  ({ id, name: id + '.png', caption: cap(subjects), stats: BRAND_TARGET, ...extra });

test('a post about muscle strength is a movement post; an assessment post is a diagnosis post', () => {
  assert.equal(pillarsForText('Muscle strength and longevity — why staying active matters at every age')[0], 'movement');
  assert.equal(pillarsForText('Why effective care begins with a thorough medical assessment: history, symptoms, lab work')[0], 'diagnosis');
  assert.equal(pillarsForText('Personalized supplementation: vitamins chosen from your labs')[0], 'supplementation');
  assert.deepEqual(pillarsForText(''), []);
  assert.deepEqual(pillarsForText('the and of'), [], 'nothing named, nothing offered');
});

test('the best pillar wins, and within it a fresh photograph beats a better one used lately', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const photos = [
    photo('consult', ['consultation']),
    photo('gym-used', ['movement'], { lastUsedAt: now - 3 * day }),
    photo('gym-fresh', ['movement', 'exterior'], { lastUsedAt: now - (REUSE_WINDOW_DAYS + 1) * day }),
  ];
  const m = pickFresh(photos, ['movement', 'diagnosis'], now);
  assert.equal(m?.id, 'gym-fresh', 'the movement photo not used in the window, even though the used one is more focused');
  assert.equal(m?.repeated, false);
  // Nothing fresh under movement: the least recently used is taken, and said to be a repeat.
  const busy = [photo('a', ['movement'], { lastUsedAt: now - 2 * day }), photo('b', ['movement'], { lastUsedAt: now - 10 * day })];
  const r = pickFresh(busy, ['movement'], now);
  assert.equal(r?.id, 'b');
  assert.equal(r?.repeated, true);
  // A pillar with nothing falls through to the next.
  assert.equal(pickFresh(photos, ['sleep', 'diagnosis'], now)?.id, 'consult');
  assert.equal(pickFresh(photos, ['sleep'], now), null, 'no near-miss');
});

test('the cover rules, consent and colour still refuse a photograph, and the current one can be excluded', () => {
  const now = Date.now();
  const photos = [
    { ...photo('text', ['movement']), caption: cap(['movement'], ['text']) },
    { ...photo('patient', ['movement']), caption: cap(['movement'], ['identifiable-patient']) },
    photo('unmeasured', ['movement'], { stats: null }),
    photo('ok', ['movement']),
  ];
  assert.equal(pickFresh(photos, ['movement'], now)?.id, 'ok');
  assert.equal(pickFresh(photos, ['movement'], now, { exclude: ['ok'] }), null, '"make it again" never hands back the same photo');
  assert.equal(pickFresh([{ ...photos[1], consentCleared: true }], ['movement'], now)?.id, 'patient', 'a release clears a patient');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefPromptFrom, isSearchShaped, isShoppingShaped, pickPrimary, withoutShopping, type ScoredKeyword } from './keyword-brief.ts';

const kw = (keyword: string, volume = 1000, difficulty = 30): ScoredKeyword => ({ keyword, volume, difficulty });

test('a query shape is recognised in both languages', () => {
  assert.ok(isSearchShaped('red light therapy near me'));
  assert.ok(isSearchShaped('terapia de luz roja cerca de mi'));
  assert.ok(isSearchShaped('stem cell therapy cost'));
  assert.ok(isSearchShaped('best regenerative clinic'));
  assert.ok(isSearchShaped('eboo reviews'));
  assert.ok(isSearchShaped('clinics in cancun'));
});

test('a phrase a person would actually say is not search-shaped', () => {
  assert.ok(!isSearchShaped('red light therapy'));
  assert.ok(!isSearchShaped('ozone dialysis'));
  assert.ok(!isSearchShaped('nervous system regulation'));
  // The words that trigger the rule must be whole words, not substrings:
  // "bestow", "priceless", "increase" must not be caught.
  assert.ok(!isSearchShaped('bestow wellness'));
  assert.ok(!isSearchShaped('priceless recovery'));
});

test('an accented Spanish word is not mistaken for a query shape', () => {
  // JavaScript's \b is ASCII-only and fires between "mejor" and "ía", so the
  // first version of this rule barred "mejoría del paciente" — the ordinary
  // clinical word for improvement — from ever leading a caption.
  assert.ok(!isSearchShaped('mejoría del paciente'));
  assert.ok(!isSearchShaped('mejoria sin acento'));
  assert.ok(isSearchShaped('mejor clínica de células madre'));
  assert.ok(isSearchShaped('mejores tratamientos'));
  // Plurals of the price shapes, which the first version missed entirely.
  assert.ok(isSearchShaped('tratamientos baratos'));
  assert.ok(isSearchShaped('reseñas de pacientes'));
  assert.ok(isSearchShaped('cuánto cuesta el tratamiento'));
  // ...without catching the words they are prefixes of.
  assert.ok(!isSearchShaped('un momento precioso'));
});

test('the search-shaped phrase does not lead when a speakable one exists', () => {
  // Sorted best-first, as selectBrief passes it: the query shape scores highest.
  const primary = pickPrimary([kw('red light therapy near me', 9000, 20), kw('red light therapy', 5000, 40)]);
  assert.equal(primary?.keyword, 'red light therapy');
});

test('a speakable hard word beats an easy query shape', () => {
  const primary = pickPrimary([kw('eboo therapy cost', 8000, 10), kw('ozone dialysis', 400, 85)]);
  assert.equal(primary?.keyword, 'ozone dialysis');
});

test('when everything is search-shaped a primary is still chosen', () => {
  // The brief must never be emptied: losing the keyword data entirely is worse
  // than an awkward primary the prompt now keeps out of the opening line.
  const primary = pickPrimary([kw('stem cells near me', 9000, 80), kw('stem cells cost', 3000, 30)]);
  assert.equal(primary?.keyword, 'stem cells cost', 'falls back to the old KD <= 60 rule');
});

test('an empty candidate list yields no primary rather than throwing', () => {
  assert.equal(pickPrimary([]), null);
});

test('the brief never tells the model to put the keyword in the headline', () => {
  // The single regression this file exists to prevent.
  const out = briefPromptFrom({
    primary: kw('red light therapy'),
    supporting: [kw('red light bed')],
    questions: [{ keyword: 'does red light therapy work' }],
    intentSummary: 'informational',
    source: 'semrush',
  });
  assert.ok(!/headline/i.test(out), 'must not mention the headline');
  assert.ok(!/\bhook\b/i.test(out), 'must not mention the hook');
  assert.match(out, /BODY 2-3 times/);
});

test('the brief says out loud which source owns the first sentence', () => {
  const out = briefPromptFrom({
    primary: kw('red light therapy'),
    supporting: [],
    questions: [],
    intentSummary: 'informational',
    source: 'semrush',
  });
  assert.match(out, /opening line is NOT the keyword/i);
  assert.match(out, /transcript is right and the keywords are wrong/i);
});

test('no Semrush data means no contract at all', () => {
  const none = briefPromptFrom({ primary: null, supporting: [], questions: [], intentSummary: '', source: 'none' });
  assert.equal(none, '');
  // A 'semrush' source with no primary is the same nothing, not a half-written
  // contract naming an undefined keyword.
  assert.equal(briefPromptFrom({ primary: null, supporting: [], questions: [], intentSummary: 'x', source: 'semrush' }), '');
  assert.equal(briefPromptFrom(null), '');
});

test('shopping searches leave the brief entirely — this is row 183', () => {
  // Semrush returned both of these for a video about a clinic's oxygen
  // protocol. Someone buying a lamp is not someone the clinic can treat.
  assert.ok(isShoppingShaped('red light therapy at home'));
  assert.ok(isShoppingShaped('red light therapy devices'));
  assert.ok(isShoppingShaped('buy red light panel'));
  assert.ok(isShoppingShaped('comprar dispositivo de luz roja'));
  // Care, not equipment.
  assert.ok(!isShoppingShaped('red light therapy'));
  assert.ok(!isShoppingShaped('red light therapy benefits'));
  assert.ok(!isShoppingShaped('hyperbaric oxygen therapy'));
});

test('the real row 183 keyword set, filtered and ranked', () => {
  const real = ['red light therapy near me', 'red light therapy', 'red light therapy benefits',
    'red healing', 'red lights', 'red light therapy at home', 'red light therapy devices']
    .map((keyword) => kw(keyword));
  const kept = withoutShopping(real).map((k) => k.keyword);
  assert.ok(!kept.includes('red light therapy at home'));
  assert.ok(!kept.includes('red light therapy devices'));
  assert.ok(kept.includes('red light therapy'));
  // And the query shape still loses the lead to the speakable one.
  assert.equal(pickPrimary(kept.map((k) => kw(k)))?.keyword, 'red light therapy');
});

test('a brief made entirely of shopping searches is kept rather than emptied', () => {
  const all = [kw('red light devices'), kw('red light panels for sale')];
  assert.equal(withoutShopping(all).length, 2, 'losing the data is worse than an imperfect term');
});

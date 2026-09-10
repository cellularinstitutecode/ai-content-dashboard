import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openingLineOf, repeatsOpening, signatureOf, stemOf, similarity } from './opening-line.ts';

test('the opening line is the first sentence, not the whole caption', () => {
  const copy = 'Ozone runs through a dialyser at 42 degrees. Then it returns.\n\nSecond paragraph.\n\nREF: Smith 2020\n\n#cellularinstitute';
  assert.equal(openingLineOf(copy), 'Ozone runs through a dialyser at 42 degrees.');
});

test('a decimal or an abbreviation does not end the sentence early', () => {
  assert.equal(openingLineOf('The chamber holds 1.3 atmospheres of pressure. Next.'), 'The chamber holds 1.3 atmospheres of pressure.');
});

test('a caption with no full stop still yields its opening', () => {
  assert.equal(openingLineOf('A single line with no terminator'), 'A single line with no terminator');
  assert.equal(openingLineOf(''), '');
});

test('house vocabulary does not count as identity', () => {
  // Every caption says "regenerative medicine" and "therapy". If those counted,
  // every pair of posts would read as a duplicate and the check would be noise.
  assert.deepEqual(signatureOf('Regenerative medicine therapy for patient health'), []);
  assert.ok(signatureOf('Ozone runs through a dialyser').includes('dialyser'));
});

test('the same sentence rebuilt in a different order is still the same sentence', () => {
  const a = 'Safety in regenerative medicine starts long before a therapy reaches the patient.';
  const b = 'Long before a therapy reaches the patient, safety is what regenerative medicine starts with.';
  assert.ok(similarity(a, b) >= 0.5, 'reordering must not disguise a repeat');
});

test('two genuinely different openings are not flagged', () => {
  const a = 'Ozone runs through a dialyser at 42 degrees before it goes back in.';
  const b = 'The red light panel sits eighteen inches from the skin for twelve minutes.';
  assert.ok(similarity(a, b) < 0.5);
  assert.equal(repeatsOpening(a, [b]), null);
});

test('the literal complaint: several posts opening on the same first words', () => {
  const prior = 'Safety in regenerative medicine starts long before a therapy reaches the patient.';
  const next = 'Safety in regenerative medicine starts long before a patient ever books a consultation.';
  const hit = repeatsOpening(next, [prior]);
  assert.ok(hit, 'must catch the shared opening stem');
  assert.equal(hit?.by, 'stem');
});

test('the worst match across several recent posts is the one reported', () => {
  const recent = [
    'The red light panel sits eighteen inches from the skin.',
    'Oxygen pressure is held at 1.3 atmospheres for sixty minutes.',
  ];
  assert.equal(repeatsOpening('Ozone runs through a dialyser at 42 degrees.', recent), null);
  const hit = repeatsOpening('Oxygen pressure is held at 1.3 atmospheres for ninety minutes.', recent);
  assert.ok(hit);
});

test('an empty history flags nothing, and neither does an empty candidate', () => {
  assert.equal(repeatsOpening('Ozone runs through a dialyser.', []), null);
  assert.equal(repeatsOpening('', ['Ozone runs through a dialyser.']), null);
  // A candidate with almost no identifying words cannot be judged either way;
  // flagging it would send every terse opener back for a rewrite.
  assert.equal(repeatsOpening('It is here.', ['Ozone runs through a dialyser.']), null);
});

test('a blank entry in the history is skipped rather than matched', () => {
  assert.equal(repeatsOpening('Ozone runs through a dialyser.', ['', '   ']), null);
});

test('the stem is raw and the overlap is filtered, and both are needed', () => {
  // The bug in the first version of this file. Filtering house vocabulary is
  // right for the overlap score — otherwise every pair of the clinic's posts
  // looks like a duplicate — but it erases the house FORMULA, which is built
  // almost entirely out of the words being filtered.
  const line = 'Safety in regenerative medicine starts long before a therapy reaches the patient.';
  assert.deepEqual(signatureOf(line), ['safety', 'reaches'], 'filtered: almost nothing left');
  assert.deepEqual(stemOf(line).slice(0, 5), ['safety', 'in', 'regenerative', 'medicine', 'starts']);
});

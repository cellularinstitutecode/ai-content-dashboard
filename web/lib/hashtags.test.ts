// Unit tests for the KEYWORDS cell's hashtags. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUSE_HASHTAG, MAX_HASHTAGS, hashtagFrom, hashtagsFrom } from './hashtags.ts';

test('a phrase becomes one closed-up lowercase tag', () => {
  assert.equal(hashtagFrom('Red Light Therapy'), '#redlighttherapy');
  assert.equal(hashtagFrom('hyperbaric oxygen'), '#hyperbaricoxygen');
  assert.equal(hashtagFrom('  Regenerative   Medicine  '), '#regenerativemedicine');
});

// Half the sheet is Spanish. Stripping accents instead of folding them would
// cut every accented word short — "cirugía" losing its tail to become #cirug.
test('accents fold to their base letter, never truncating the word', () => {
  assert.equal(hashtagFrom('cirugía'), '#cirugia');
  assert.equal(hashtagFrom('medicina regenerativa en Cancún'), '#medicinaregenerativaencancun');
  assert.equal(hashtagFrom('células madre'), '#celulasmadre');
});

test('punctuation closes up rather than splitting the tag', () => {
  assert.equal(hashtagFrom('anti-aging'), '#antiaging');
  assert.equal(hashtagFrom('PRP vs. stem cells'), '#prpvsstemcells');
  assert.equal(hashtagFrom('#alreadyatag'), '#alreadyatag');
});

test('what cannot be a tag is dropped, not mangled into one', () => {
  assert.equal(hashtagFrom(''), '');
  assert.equal(hashtagFrom('a'), '', 'too short to mean anything');
  assert.equal(hashtagFrom('!!!'), '');
  assert.equal(hashtagFrom('2026 trends'), '', 'most networks refuse a tag starting with a digit');
  assert.equal(hashtagFrom('a'.repeat(40)), '', 'a sentence pasted into the wrong cell');
  assert.equal(hashtagFrom(null), '');
});

test('the house tag leads and the brief follows', () => {
  const out = hashtagsFrom(['red light therapy', 'hyperbaric oxygen']);
  assert.deepEqual(out, [HOUSE_HASHTAG, '#redlighttherapy', '#hyperbaricoxygen']);
});

// Semrush returns casing variants of the same phrase as separate keywords.
test('casing variants collapse to one tag', () => {
  const out = hashtagsFrom(['Red Light Therapy', 'red light therapy', 'RED LIGHT THERAPY']);
  assert.deepEqual(out, [HOUSE_HASHTAG, '#redlighttherapy']);
});

test('the house tag is never repeated by a keyword that matches it', () => {
  const out = hashtagsFrom(['Cellular Institute', 'longevity medicine']);
  assert.deepEqual(out, [HOUSE_HASHTAG, '#longevitymedicine']);
});

test('a caption is not allowed to become tag spam', () => {
  const many = Array.from({ length: 40 }, (_, i) => 'keyword number ' + 'x'.repeat(i + 3));
  assert.equal(hashtagsFrom(many).length, MAX_HASHTAGS);
});

test('the house tag can be turned off without losing the rest', () => {
  assert.deepEqual(hashtagsFrom(['stem cells'], { house: '' }), ['#stemcells']);
});

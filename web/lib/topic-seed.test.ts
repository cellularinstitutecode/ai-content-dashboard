import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSeed } from './topic-seed.ts';

/** The tokenising lib/video-copy.ts does before calling pickSeed. */
const w = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);

test('the subject wins over sheer repetition — this is row 183', () => {
  // Reel_RyallOxygenCircuit_Rodrigo. The speaker dwells on the red light bed,
  // so "red light" is said more often than "hyperbaric oxygen" — and the old
  // rule therefore researched consumer red-light gear for a post about the
  // clinic's oxygen protocol.
  const words = w('oxygen circuit hyperbaric oxygen therapy red light bed red light wavelengths red light bed hyperbaric oxygen therapy');
  assert.equal(pickSeed(words), 'red light', 'unanchored: repetition wins, which is the bug');
  assert.equal(pickSeed(words, w('oxygen circuit')), 'hyperbaric oxygen', 'anchored: the subject wins');
});

test('a subject-corroborated phrase said twice beats an unrelated one said many times', () => {
  // Ruled out by construction rather than tuned: any single weighted score lets
  // raw repetition win eventually, and that is the failure being fixed.
  const words = w('red light red light red light red light red light hyperbaric oxygen hyperbaric oxygen');
  assert.equal(pickSeed(words, w('oxygen circuit')), 'hyperbaric oxygen');
});

test('a subject that corroborates nothing falls back to the old behaviour', () => {
  const words = w('exosomes matter exosomes again something else entirely');
  assert.equal(pickSeed(words, w('floating bed')), pickSeed(words));
});

test('no subject at all is exactly the old behaviour', () => {
  const words = w('regenerative medicine is regenerative medicine after all');
  assert.equal(pickSeed(words), 'regenerative medicine');
  assert.equal(pickSeed(words, []), 'regenerative medicine');
});

test('said once is still not a theme', () => {
  // The bar the previous rule set, preserved: nothing repeated means no signal,
  // and '' tells the caller to keep the file name's subject.
  assert.equal(pickSeed(w('patient walked into clinic today')), '');
  assert.equal(pickSeed([]), '');
  // Corroboration does not lower the bar. At a bar of one, every adjacent pair
  // touching a subject word qualifies and "into clinic" wins on a transcript
  // that merely mentions the clinic once.
  assert.equal(pickSeed(w('patient walked into clinic today'), w('clinic visit')), '');
});

test('a single repeated word is used when no pair repeats', () => {
  assert.equal(pickSeed(w('exosomes matter exosomes again something else entirely')), 'exosomes');
  // And the subject steers that fallback too.
  const words = w('exosomes matter exosomes again oxygen once oxygen twice');
  assert.equal(pickSeed(words, w('oxygen circuit')), 'oxygen');
});

test('a phrase that only restates the subject is skipped', () => {
  // This function is reached BECAUSE the subject returned nothing from Semrush.
  // Re-seeding on the subject spends a second lookup to fail the same way.
  const words = w('oxygen circuit oxygen circuit hyperbaric oxygen therapy hyperbaric oxygen therapy');
  assert.equal(pickSeed(words, w('oxygen circuit')), 'hyperbaric oxygen');
});

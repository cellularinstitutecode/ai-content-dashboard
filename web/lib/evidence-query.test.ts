import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROAD_TERMS, MAX_TERMS, evidenceQuery } from './evidence-query.ts';

const words = (q: string) => (q ? q.split(' ') : []);

test('a query is never long enough to AND itself into nothing', () => {
  // The measured failure this file exists for: 7 terms returned 0 results on
  // the live index, 5 returned 41. PubMed ANDs everything.
  const q = evidenceQuery('Reel_RyallOxygenCircuit_Rodrigo', [
    'hyperbaric oxygen therapy', 'tissue oxygenation', 'recovery protocol', 'stem cell priming',
  ]);
  assert.ok(words(q.primary).length <= MAX_TERMS, q.primary);
  assert.ok(words(q.broad).length <= BROAD_TERMS);
});

test('the subject leads, and the keywords sharpen it', () => {
  // Keywords alone are a search-volume ranking, not a clinical one — once they
  // were consumer red-light gear for a video about an oxygen protocol.
  const q = evidenceQuery('Oxygen Circuit', ['hyperbaric oxygen']);
  assert.equal(words(q.primary)[0], 'oxygen');
  assert.ok(q.primary.includes('circuit'));
  assert.ok(q.primary.includes('hyperbaric'));
});

test('house vocabulary is dropped — it costs an AND clause and narrows nothing', () => {
  // "regenerative", "therapy", "clinic" appear in every subject this clinic
  // films, so as search terms they only shrink the result set.
  const q = evidenceQuery('Regenerative Therapy Clinic Exosomes');
  assert.equal(q.primary, 'exosomes');
});

test('the file-name furniture never reaches the search', () => {
  const q = evidenceQuery('Web_FinalCompCorporativo_Rodrigo');
  assert.ok(!/final|comp|corporativo|web/.test(q.primary), q.primary);
});

test('a broad retry is offered only when it is genuinely wider', () => {
  const many = evidenceQuery('Oxygen Circuit', ['hyperbaric chamber']);
  assert.ok(words(many.broad).length < words(many.primary).length);
  // One term cannot be narrowed further, so a second request would repeat the
  // first and cost a round trip for the same answer.
  assert.equal(evidenceQuery('Exosomes').broad, '');
});

test('nothing to search for is an empty query, not a query for nothing', () => {
  assert.deepEqual(evidenceQuery(''), { primary: '', broad: '' });
  assert.deepEqual(evidenceQuery('the clinic', []), { primary: '', broad: '' });
});

test('duplicate words across subject and keywords are not AND-ed twice', () => {
  const q = evidenceQuery('Exosome Therapy', ['exosome benefits', 'exosome']);
  assert.equal(words(q.primary).filter((w) => w === 'exosome').length, 1);
});

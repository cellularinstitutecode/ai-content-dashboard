import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ABSTRACT_CHARS, MAX_ITEMS, evidenceBriefFrom, type EvidenceItem } from './evidence-brief.ts';

/** A real result, from the live PubMed search run while designing this. */
const REAL: EvidenceItem = {
  title: 'Harmonised culture procedures minimise but do not eliminate mesenchymal stromal cell donor and tissue variability in a decentralised multicentre manufacturing approach.',
  journal: 'Stem Cell Research & Therapy',
  year: 2023,
  doi: '10.1186/s13287-023-03352-1',
  firstAuthor: 'Calcat-i-Cervera, S.',
  abstract: 'Mesenchymal stromal cells (MSCs) have been widely used in many medical conditions. Clinical potency can vary considerably depending on tissue source, donor attributes, but importantly, also culture conditions. These results show that the use of harmonised culture procedures can reduce but do not eliminate inter-lab and operator differences.',
};

const item = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({ ...REAL, ...over });

test('the brief carries the citation, the DOI and the abstract', () => {
  const out = evidenceBriefFrom([REAL]);
  assert.match(out, /Calcat-i-Cervera, S\. \(2023\)/);
  assert.match(out, /10\.1186\/s13287-023-03352-1/);
  assert.match(out, /reduce but do not eliminate/);
});

test('all three prohibitions are stated, every time', () => {
  // These are the conditions under which quoting research is safe for a clinic
  // advertising under COFEPRIS. A brief without them is not a lighter brief.
  const out = evidenceBriefFrom([REAL]);
  assert.match(out, /NEVER imply the study was conducted at this clinic/);
  assert.match(out, /NEVER turn a mechanism into a promise/);
  assert.match(out, /NEVER state anything the abstract above does not support/);
});

test('the writer is told to copy the DOI rather than recall one', () => {
  // The whole point: the citation stops being a thing the model remembers.
  const out = evidenceBriefFrom([REAL]);
  assert.match(out, /copying its DOI\s+exactly as given/);
  assert.match(out, /Do not cite a study from memory/);
});

test('an irrelevant match can be discarded rather than forced', () => {
  // Keyword search is not clinical judgement. Insisting on a paper that does
  // not fit is how a post ends up citing furniture research.
  assert.match(evidenceBriefFrom([REAL]), /If none of them actually relates to this video, ignore them/);
});

test('no research is a quieter post, never a failed one', () => {
  assert.equal(evidenceBriefFrom([]), '');
  // Anything missing its DOI or abstract cannot be quoted safely, so it is not offered.
  assert.equal(evidenceBriefFrom([item({ doi: '' })]), '');
  assert.equal(evidenceBriefFrom([item({ abstract: '   ' })]), '');
  assert.equal(evidenceBriefFrom([item({ title: '' })]), '');
});

test('a long abstract is cut at a sentence end, and says it was cut', () => {
  // An abstract truncated before its limitations reads more certain than the
  // paper is — which is the third prohibition, broken by the brief itself.
  const long = item({ abstract: 'One finding here. '.repeat(200) });
  const out = evidenceBriefFrom([long]);
  // The line, not everything after the marker — the guardrails follow it in the
  // same string, and an earlier version of this test measured those too.
  const abstract = (out.split('\n').find((l) => l.startsWith('ABSTRACT: ')) || '').slice('ABSTRACT: '.length);
  assert.ok(abstract.length < MAX_ABSTRACT_CHARS + 40, String(abstract.length));
  assert.match(abstract, /\[…\]/);
  assert.match(abstract, /finding here\. \[…\]/, 'cut at a sentence end, not mid-claim');
});

test('a reading list is capped at a brief', () => {
  const out = evidenceBriefFrom([item(), item({ doi: '10.1/b' }), item({ doi: '10.1/c' }), item({ doi: '10.1/d' })]);
  assert.equal((out.match(/^\[\d\] /gm) || []).length, MAX_ITEMS);
});

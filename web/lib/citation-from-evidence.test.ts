import test from 'node:test';
import assert from 'node:assert/strict';
import { citable, pickCitation, refLineFrom, refLineFromEvidence } from './citation-from-evidence.ts';
import { checkCompliance, DEFAULT_AVISO_NUMBER } from './compliance.ts';
import type { EvidenceItem } from './evidence-parse.ts';

const paper = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  title: 'Hyperbaric oxygen therapy for soft tissue recovery',
  journal: 'Journal of Regenerative Medicine',
  year: 2024,
  doi: '10.1016/j.jrm.2024.01.001',
  firstAuthor: 'Smith AB',
  abstract: 'An abstract.',
  ...over,
});

test('the line it writes passes the gate that refuses posts', () => {
  // THE POINT. A citation this app writes that its own compliance check then
  // refuses would be worse than useless — the row would be prepared and the
  // post still blocked.
  const text = 'A claim about therapy.\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER + '\n' + refLineFrom(paper());
  const check = checkCompliance(text);
  assert.deepEqual(check.missing, [], 'the composed post must satisfy the rule');
  assert.equal(check.doi, '10.1016/j.jrm.2024.01.001');
});

test('the line carries the author, year, title, journal and DOI', () => {
  const line = refLineFrom(paper());
  assert.match(line, /^REF: /);
  assert.match(line, /Smith AB et al\. \(2024\)\./);
  assert.match(line, /Hyperbaric oxygen therapy for soft tissue recovery\./);
  assert.match(line, /Journal of Regenerative Medicine\./);
  assert.match(line, /DOI: 10\.1016\/j\.jrm\.2024\.01\.001$/);
});

test('an author label that already says "et al." is not doubled', () => {
  // The parsers hand over "Surname, I., et al."; the line once read
  // "Genç, Ç., et al. et al. (2025)." on a card.
  const line = refLineFrom(paper({ firstAuthor: 'Genç, Ç.Ö., et al.', year: 2025 }));
  assert.match(line, /^REF: Genç, Ç\.Ö\., et al\. \(2025\)\. Hyperbaric/);
  assert.doesNotMatch(line, /et al\.\s*et al\./);
  // Without a year the label still ends in exactly one full stop.
  assert.match(refLineFrom(paper({ firstAuthor: 'Genç, Ç., et al', year: null })), /^REF: Genç, Ç\., et al\. Hyperbaric/);
});

test('a paper with no DOI is never cited', () => {
  // Nothing is invented. No DOI means no citation, and the post is refused
  // exactly as it is today — a fabricated reference on a medical advertisement
  // is a different and much worse problem than a missing one.
  assert.equal(citable(paper({ doi: '' })), false);
  assert.equal(citable(paper({ doi: 'not-a-doi' })), false);
  assert.equal(citable(paper({ doi: '10.1016/x', title: '' })), false, 'and no title is no citation either');
  assert.equal(refLineFromEvidence([paper({ doi: '' })]), null);
  assert.equal(refLineFromEvidence([]), null);
  assert.equal(refLineFromEvidence(null), null);
});

test('PubMed\u2019s relevance order is kept, not overridden by recency', () => {
  // This used to sort by year, which threw away the ranking the search was
  // asked for (`sort=relevance`): a newer but less relevant paper displaced
  // the best match for the subject. On a medical advertisement the citation
  // being ABOUT the claim matters more than it being recent.
  const chosen = pickCitation([
    paper({ year: 1998, doi: '10.1016/best-match' }),
    paper({ year: 2024, doi: '10.1016/newer-but-worse' }),
  ]);
  assert.equal(chosen?.doi, '10.1016/best-match');
});

test('an uncitable paper never blocks a citable one behind it', () => {
  const line = refLineFromEvidence([paper({ doi: '' }), paper({ doi: '10.1016/real', year: 2020 })]);
  assert.match(String(line), /10\.1016\/real/);
});

test('missing pieces degrade rather than produce a malformed line', () => {
  const line = refLineFrom(paper({ firstAuthor: '', journal: '', year: null }));
  assert.match(line, /^REF: /);
  assert.match(line, /DOI: 10\./);
  assert.doesNotMatch(line, /undefined|null|NaN/);
  // It must still satisfy the gate, which is the only thing that matters.
  assert.deepEqual(checkCompliance('x\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER + '\n' + line).missing, []);
});

test('a paper stored before the parser decoded entities still prints as a name', () => {
  // pack._evidence on older drafts carries the raw reference; the card showed
  // "L&#xf3;pez-Medina, E., et al." inside the Fix citation note.
  const line = refLineFrom(paper({ firstAuthor: 'L&#xf3;pez-Medina, E., et al.', title: 'Effect of Ivermectin &amp; placebo', journal: 'JAMA &#8211; the journal', year: 2021 }));
  assert.match(line, /^REF: López-Medina, E\., et al\. \(2021\)\. Effect of Ivermectin & placebo\. JAMA – the journal\. DOI: /);
  assert.doesNotMatch(line, /&#|&amp;/);
});

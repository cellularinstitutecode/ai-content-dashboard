import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftDefect } from './draft-defect.ts';

test('a draft with a citation and no names is publishable', () => {
  assert.equal(draftDefect('Smith et al., Nature (2024). https://doi.org/10.1000/x', []), null);
});

test('a missing citation is a defect, and the writer is told it is mandatory', () => {
  const d = draftDefect('', []);
  assert.equal(d?.kind, 'no_citation');
  assert.match(String(d?.corrective), /no REF line/);
  assert.match(String(d?.corrective), /cannot be published without one/);
});

test('whitespace is not a citation', () => {
  assert.equal(draftDefect('   ', [])?.kind, 'no_citation');
});

test('a leaked name is a defect, and the corrective quotes the name back', () => {
  const d = draftDefect('Smith et al. https://doi.org/10.1000/x', ['Rodrigo']);
  assert.equal(d?.kind, 'named_a_person');
  assert.match(String(d?.corrective), /"Rodrigo"/);
  assert.match(String(d?.corrective), /never attribute a quote/i);
});

test('several leaked names are all named back', () => {
  const d = draftDefect('ref', ['Rodrigo', 'Ryall']);
  assert.match(String(d?.corrective), /"Rodrigo" and "Ryall"/);
});

test('both problems are corrected in one attempt, not traded for each other', () => {
  const d = draftDefect('', ['Rodrigo']);
  // The name outranks the citation for which refusal this becomes...
  assert.equal(d?.kind, 'named_a_person');
  // ...but the writer is told about both, so one more draft can fix both.
  assert.match(String(d?.corrective), /"Rodrigo"/);
  assert.match(String(d?.corrective), /no REF line/);
});

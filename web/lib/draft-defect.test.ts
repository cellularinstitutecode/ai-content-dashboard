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

test('a leaked name is a defect, and the rule sent back is categorical', () => {
  const d = draftDefect('Smith et al. https://doi.org/10.1000/x', ['Rodrigo']);
  assert.equal(d?.kind, 'named_a_person');
  assert.match(String(d?.corrective), /never attribute a quote/i);
});

test('the corrective never repeats the banned name back into the prompt', () => {
  // Putting it back is how the model came to write "As our patient Rodrigo
  // shares:" in the first place — the file name was in the prompt. Telling a
  // model to avoid a token is a well-known way to make it produce that token,
  // and the rule is categorical, so the name is not needed to state it.
  for (const d of [draftDefect('ref', ['Rodrigo']), draftDefect('', ['Rodrigo', 'Ryall'])]) {
    assert.ok(!/Rodrigo/i.test(String(d?.corrective)), 'leaked the banned name back');
    assert.ok(!/Ryall/i.test(String(d?.corrective)), 'leaked the banned name back');
  }
});

test('several leaked names still read as plural', () => {
  assert.match(String(draftDefect('ref', ['Rodrigo', 'Ryall'])?.corrective), /named people/);
});

test('both problems are corrected in one attempt, not traded for each other', () => {
  const d = draftDefect('', ['Rodrigo']);
  // The name outranks the citation for which refusal this becomes...
  assert.equal(d?.kind, 'named_a_person');
  // ...but the writer is told about both, so one more draft can fix both.
  assert.match(String(d?.corrective), /named a person/);
  assert.match(String(d?.corrective), /no REF line/);
});

test('a repeated opening asks for another draft but never refuses the video', () => {
  const d = draftDefect('Smith 2020 doi:10/x', [], true);
  assert.equal(d?.kind, 'repeats_opening');
  // The whole point: one more attempt, and publish either way. A caption that
  // opens like last week's is a matter of style, not a reason to hold a video.
  assert.equal(d?.blocking, false);
  assert.match(String(d?.corrective), /throw it away/i);
});

test('the opening corrective never quotes the sentence it is correcting', () => {
  // Same lesson as nameCorrective: handing a model a sentence and saying "not
  // that one" is how you get that one back with the nouns swapped — which is
  // the exact failure being corrected.
  const d = draftDefect('Smith 2020 doi:10/x', [], true);
  assert.ok(!/safety in regenerative medicine/i.test(String(d?.corrective)));
  assert.match(String(d?.corrective), /CONCRETE/);
});

test('a real defect alongside a repeated opening still blocks, and fixes both', () => {
  const d = draftDefect('', [], true);
  assert.equal(d?.kind, 'no_citation');
  assert.equal(d?.blocking, true);
  // Both correctives ride along, so one more attempt can fix both rather than
  // trading one for the other.
  assert.match(String(d?.corrective), /REF/);
  assert.match(String(d?.corrective), /throw it away/i);

  const named = draftDefect('Smith 2020 doi:10/x', ['Rodrigo'], true);
  assert.equal(named?.kind, 'named_a_person');
  assert.equal(named?.blocking, true);
});

test('a clean draft is still clean when nothing repeats', () => {
  assert.equal(draftDefect('Smith 2020 doi:10/x', [], false), null);
  assert.equal(draftDefect('Smith 2020 doi:10/x', []), null, 'the third argument is optional');
});

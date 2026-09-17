// web/lib/claim-support.test.ts
//
// WHAT THIS PROTECTS.
//
// Every citation check in this codebase asks whether the paper EXISTS. PubMed
// returned it, it has a DOI, Crossref resolves it, the compliance gate can see
// a REF line. A post could pass all four while claiming an outcome the paper
// never measured — a real reference lending authority it never gave, printed
// under a medical advertisement.
//
// Two properties matter more than any single case below, and both are asserted
// directly:
//
//   1. AMBIGUITY NEVER BECOMES A CITATION. Anything the judge says that cannot
//      be read with confidence resolves to 'unchecked', which means "carry on
//      exactly as before this check existed" — never to a paper index. A
//      confidently mis-parsed answer would put the WRONG paper under the claim,
//      which is worse than the state this file was written to fix.
//
//   2. THE CHECK CANNOT REFUSE A VIDEO. It repairs — swap the paper, search
//      again, ask for one more draft — and the post publishes either way. That
//      was the instruction: "It should fix the post, not refuse it... but it
//      has to be automatic."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_CANDIDATES,
  claimFrom,
  claimQuery,
  claimSupportNote,
  parseSupportVerdict,
  supportPrompt,
  supportedItem,
  type SupportVerdict,
} from './claim-support.ts';
import { composeCaption, withCitation } from './video-copy.ts';
import { DEFAULT_AVISO_NUMBER, checkCompliance } from './compliance.ts';
import { refLineFrom } from './citation-from-evidence.ts';
import { draftDefect } from './draft-defect.ts';
import { frequentTerms } from './evidence-query.ts';
import type { EvidenceItem } from './evidence-parse.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const paper = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  title: 'Photobiomodulation and muscle recovery: a randomised controlled trial',
  journal: 'Lasers in Medical Science',
  year: 2024,
  doi: '10.1007/s10103-024-04012-3',
  firstAuthor: 'Nguyen, T., et al.',
  abstract: 'Thirty-two athletes received 660 nm and 850 nm irradiation after eccentric exercise. ' +
    'Creatine kinase and perceived soreness were lower at 48 hours in the treated group.',
  ...over,
});

// --- 1. WHAT COUNTS AS THE CLAIM -------------------------------------------

test('the claim is the copy, not the furniture printed under it', () => {
  // A judge handed the permit number and the citation is being asked a
  // different question: whether the paper supports the reference to itself is
  // not in doubt. The AVISO, the REF line, the hashtags and the Watch link are
  // all removed, and what is left is the part that actually asserts something.
  const caption = [
    'Red light at two wavelengths, used after training.',
    '',
    'Watch: https://youtu.be/abc123',
    '',
    'REF: Nguyen, T., et al. (2024). Photobiomodulation. Lasers in Medical Science. DOI: 10.1007/s10103-024-04012-3',
    '',
    'AVISO DE PUBLICIDAD: 2623022002A00090',
    '',
    '#redlight #recovery #cancun',
  ].join('\n');

  const claim = claimFrom(caption);
  assert.equal(claim, 'Red light at two wavelengths, used after training.');
  assert.ok(!/AVISO/i.test(claim), 'the permit number is not a claim');
  assert.ok(!/DOI/i.test(claim), 'the citation is not a claim');
  assert.ok(!/#/.test(claim), 'hashtags are not a claim');
  assert.ok(!/youtu\.be/.test(claim), 'the watch link is not a claim');
});

test('an empty caption is an empty claim, and never a judgement', () => {
  assert.equal(claimFrom(''), '');
  assert.equal(claimFrom(null), '');
  // The caller reads '' as "nothing to judge" and skips the call entirely.
});

// --- 2. READING THE VERDICT ------------------------------------------------

test('a plain answer names the paper', () => {
  assert.deepEqual(parseSupportVerdict('{"supports": 2}', 3), { status: 'supported', index: 1 });
  // Numbered from 1 for the model, indexed from 0 for the code. Getting this
  // backwards would silently cite the neighbouring paper.
  assert.deepEqual(parseSupportVerdict('{"supports": 1}', 3), { status: 'supported', index: 0 });
});

test('"none of them" is an answer, and a different one from "I do not know"', () => {
  // This distinction is the whole design. 'none' starts the repair — search
  // again, re-roll the draft. 'unchecked' changes nothing at all.
  assert.deepEqual(parseSupportVerdict('{"supports": null}', 3), { status: 'none' });
  assert.deepEqual(parseSupportVerdict('{"supports": 0}', 3), { status: 'none' });
  assert.deepEqual(parseSupportVerdict('{"supports": "none"}', 3), { status: 'none' });
});

test('anything unreadable is unchecked — never a paper', () => {
  // THE PROPERTY THAT KEEPS THIS SAFE. Every one of these, read optimistically,
  // would print a reference under a claim nothing verified.
  const junk = [
    '',
    'I think the second one is probably closest?',
    '{"supports": true}',
    '{"supports": [2]}',
    '{"supported": 2}',
    '{"supports": 2.5}',
    '{"supports": -1}',
    'not json at all',
    '{ broken',
  ];
  for (const text of junk) {
    assert.equal(parseSupportVerdict(text, 3).status, 'unchecked', 'unreadable: ' + JSON.stringify(text));
  }
});

test('an index past the papers offered is unchecked, not the last paper', () => {
  // A model that answers "4" when it was shown 3 has not read them. Clamping to
  // the nearest real paper would turn that confusion into a citation.
  assert.equal(parseSupportVerdict('{"supports": 4}', 3).status, 'unchecked');
  assert.equal(parseSupportVerdict('{"supports": 3}', 2).status, 'unchecked');
  // And never past the number the prompt can hold, whatever the caller passes.
  assert.equal(parseSupportVerdict('{"supports": 9}', 99).status, 'unchecked');
  assert.equal(MAX_CANDIDATES, 3);
});

test('JSON wrapped in prose or a code fence is still read', () => {
  // The model is told to answer with bare JSON. A check that quietly stopped
  // working the day a model added a fence would look exactly like a check that
  // never found anything wrong.
  assert.deepEqual(parseSupportVerdict('```json\n{"supports": 3}\n```', 3), { status: 'supported', index: 2 });
  assert.deepEqual(parseSupportVerdict('Answer: {"supports": 1}', 3), { status: 'supported', index: 0 });
});

test('the verdict resolves to the paper it points at, and nothing else does', () => {
  const items = [paper({ doi: '10.1/a' }), paper({ doi: '10.2/b' })];
  assert.equal(supportedItem(items, { status: 'supported', index: 1 })?.doi, '10.2/b');
  assert.equal(supportedItem(items, { status: 'none' }), null);
  assert.equal(supportedItem(items, { status: 'unchecked' }), null);
  assert.equal(supportedItem([], { status: 'supported', index: 0 }), null);
  assert.equal(supportedItem(items, null), null);
});

// --- 3. WHAT THE JUDGE IS SHOWN --------------------------------------------

test('the judge reads the abstracts, numbered the way it must answer', () => {
  const prompt = supportPrompt('Red light supports recovery after training.', [
    paper({ title: 'First paper', abstract: 'Creatine kinase fell at 48 hours.' }),
    paper({ title: 'Second paper', abstract: 'No effect on grip strength was observed.' }),
  ]);
  assert.ok(prompt.includes('Red light supports recovery after training.'));
  assert.ok(prompt.includes('[1] First paper'));
  assert.ok(prompt.includes('[2] Second paper'));
  assert.ok(prompt.includes('Creatine kinase fell at 48 hours.'), 'the abstract is the evidence, not the title');
  assert.ok(prompt.includes('No effect on grip strength was observed.'));
});

test('only the papers that can be answered for are shown', () => {
  // Showing a fourth paper the verdict parser would reject as out of range is a
  // way to make every answer about it 'unchecked'.
  const many = [paper({ title: 'One' }), paper({ title: 'Two' }), paper({ title: 'Three' }), paper({ title: 'Four' })];
  const prompt = supportPrompt('a claim', many);
  assert.ok(prompt.includes('[3] Three'));
  assert.ok(!prompt.includes('Four'), 'a paper past MAX_CANDIDATES cannot be chosen, so it is not offered');
});

// --- 4. SEARCHING AGAIN, AT THE CLAIM --------------------------------------

test('the re-search asks about what the copy keeps returning to, not its hook', () => {
  // The first search used the video's SUBJECT. When nothing it found backs the
  // copy, the copy has moved — so the second search is built from the copy.
  // Frequency, not order: the first words of a caption are the hook, which is
  // written to arrest a reader rather than to describe the subject.
  const claim = 'Something you would never expect. Exosomes carry signalling cargo. ' +
    'Exosomes are isolated from cultured cells, and exosome preparations vary between donors.';
  const query = claimQuery(claim);
  assert.ok(query.includes('exosome') || query.includes('exosomes'), 'the subject of the paragraph leads: ' + query);
  assert.ok(!query.startsWith('something'), 'the hook is not the subject: ' + query);
});

test('the re-search drops the words every clinic video contains', () => {
  // "therapy", "treatment", "regenerative", "clinic" cost a whole AND clause
  // each on PubMed and narrow nothing — the measured failure in
  // lib/evidence-query.ts. The stop list is shared, not copied.
  const query = claimQuery('Our regenerative therapy clinic offers peptide treatment for patients.');
  for (const noise of ['regenerative', 'therapy', 'clinic', 'treatment', 'patients']) {
    assert.ok(!query.split(' ').includes(noise), noise + ' should not be a search term: ' + query);
  }
  assert.ok(query.includes('peptide'));
});

test('frequentTerms ranks by how often, then by where', () => {
  assert.deepEqual(frequentTerms('alpha beta beta gamma', 2), ['beta', 'alpha']);
  // A caption that mentions everything once still reads in its own order.
  assert.deepEqual(frequentTerms('alpha beta gamma', 2), ['alpha', 'beta']);
  assert.deepEqual(frequentTerms('', 3), []);
});

// --- 5. SWAPPING THE PAPER ON EVERY CAPTION --------------------------------

test('a swapped citation REPLACES the rejected one, on the caption that had it', () => {
  // composeCaption keeps the FIRST REF line it finds, so appending the chosen
  // paper would have published the REJECTED one and dropped the new one. This
  // is the bug that would have made the whole check cosmetic.
  const before = [
    'Two wavelengths, used after training.',
    '',
    'REF: Wrong, A. (2019). A different subject entirely. Journal. DOI: 10.9999/wrong',
    '',
    'AVISO DE PUBLICIDAD: 2623022002A00090',
    '',
    '#redlight #recovery',
  ].join('\n');

  const after = withCitation(before, 'Nguyen, T., et al. (2024). Photobiomodulation. DOI: 10.1007/s10103-024-04012-3');
  assert.ok(after.includes('10.1007/s10103-024-04012-3'), 'the chosen paper is cited');
  assert.ok(!after.includes('10.9999/wrong'), 'the rejected paper is gone, not merely outranked');
  assert.equal((after.match(/REF:/g) || []).length, 1, 'exactly one citation');
  assert.ok(after.includes('#redlight #recovery'), 'the hashtags survive the swap');
  assert.ok(/AVISO DE PUBLICIDAD:/.test(after), 'and so does the notice');
});

test('a caption with no citation yet simply gains one', () => {
  const after = withCitation('Body copy.\n\n#tag', 'REF: Nguyen, T. (2024). Title. DOI: 10.1/x');
  assert.ok(after.includes('REF: Nguyen, T. (2024). Title. DOI: 10.1/x'));
  assert.ok(after.includes('#tag'));
  // The label is not doubled when the caller passes a whole REF line.
  assert.ok(!after.includes('REF: REF:'));
});

test('no citation to set strips the old one rather than inventing a line', () => {
  const after = withCitation('Body copy.\n\nREF: Wrong, A. DOI: 10.9999/wrong', '');
  assert.ok(!after.includes('10.9999/wrong'));
  assert.ok(!after.includes('REF:'));
});

test('the swapped caption still passes the REAL compliance gate', () => {
  // Against lib/compliance.ts itself, not a copy of its rules. A citation this
  // app swaps in that its own door then refuses would be worse than useless —
  // the exact discipline the citation recovery was built under.
  const caption = composeCaption(
    'Two wavelengths, used after training.\n\nREF: Wrong, A. (2019). Something else. DOI: 10.9999/wrong\n\n#recovery',
    DEFAULT_AVISO_NUMBER,
  );
  const swapped = withCitation(caption, refLineFrom(paper()), DEFAULT_AVISO_NUMBER);
  const check = checkCompliance(swapped, DEFAULT_AVISO_NUMBER);
  assert.deepEqual(check.missing, [], 'nothing missing after the swap');
  assert.equal(check.doi, '10.1007/s10103-024-04012-3', 'and the DOI is the chosen paper’s');
  // And the text the judge would read next time is the body alone.
  assert.equal(claimFrom(swapped), 'Two wavelengths, used after training.');
});

// --- 6. IT REPAIRS; IT NEVER REFUSES ---------------------------------------

test('an unsupported citation asks for another draft and NEVER blocks the video', () => {
  // The instruction this was built to: "It should fix the post, not refuse it
  // — after fixing we're good to go, but it has to be automatic." A blocking
  // defect is a row that stops and waits for a person, which is the outcome
  // this whole path exists to avoid.
  const defect = draftDefect('Nguyen, T. (2024). DOI: 10.1/x', [], false, true);
  assert.ok(defect, 'the writer is asked to try again');
  assert.equal(defect?.kind, 'unsupported_citation');
  assert.equal(defect?.blocking, false, 'a real, verified citation is never a reason to refuse a video');
  assert.ok(/does not actually show/i.test(defect?.corrective || ''), 'the corrective names what went wrong');
  assert.ok(
    /use the papers in the research section/i.test(defect?.corrective || ''),
    'and sends the writer to the papers already retrieved rather than off inventing one',
  );
});

test('a missing citation still blocks, exactly as before', () => {
  // The one refusal in this path is untouched. An unsupported citation is a
  // lesser problem than no citation, and must not quietly downgrade it.
  assert.equal(draftDefect('', [], false, true)?.blocking, true);
  assert.equal(draftDefect('', [], false, true)?.kind, 'no_citation');
  // A leaked name still outranks everything.
  assert.equal(draftDefect('REF ok', ['Rodrigo'], false, true)?.kind, 'named_a_person');
});

test('a clean draft is still clean when the check had nothing to say', () => {
  assert.equal(draftDefect('Nguyen, T. (2024). DOI: 10.1/x', [], false, false), null);
});

// --- 7. WHAT THE PERSON IS TOLD --------------------------------------------

test('the draft says so when the citation did not clear, and stays quiet when it did', () => {
  assert.ok(/does not clearly support/i.test(claimSupportNote({ status: 'unsupported', doi: '10.1/x' })));
  assert.ok(/not checked/i.test(claimSupportNote({ status: 'unchecked', doi: '10.1/x' })));
  assert.equal(claimSupportNote({ status: 'supported', doi: '10.1/x' }), '');
  assert.equal(claimSupportNote({ status: 'swapped', doi: '10.1/x' }), '');
  assert.equal(claimSupportNote(null), '');
});

// --- 8. THE PRODUCT ACTUALLY DOES THIS -------------------------------------
//
// A pure function nothing calls is not a check. This suite already made that
// mistake once — lib/publish-rules.test.ts asserted that videoVerdict RETURNED
// pending without asserting that anything CALLED it, and the rule was false for
// a week while the test stayed green.

test('the prepare path asks the question, on the copy it is about to save', () => {
  const prepare = src('lib/video-prepare.ts');
  assert.match(prepare, /judgeClaimSupport\(/, 'prepareVideo must ask whether the paper backs the claim');
  assert.match(prepare, /claimFrom\(/, 'and must ask about the copy, stripped of its furniture');
});

test('the ladder is wired in the order that repairs rather than refuses', () => {
  const prepare = src('lib/video-prepare.ts');
  // Rung 2: a second search, built from the claim, when nothing found backs it.
  assert.match(prepare, /claimQuery\(/, 'a claim nothing supports triggers a second search');
  assert.match(prepare, /findEvidence\(query\)/, 'and that search actually runs');
  // Rung 3: the swap reaches both captions.
  assert.match(prepare, /withCitation\(tiktok/, 'the swap must reach the TikTok caption');
  assert.match(prepare, /withCitation\(linkedin/, 'and the LinkedIn post, or one network publishes the rejected paper');
  // Rung 4: one more draft, never a refusal.
  assert.match(prepare, /draftDefect\(ref, leaked, Boolean\(repeat\), unsupported\)/, 'the writer gets one more attempt');
});

test('nothing in the prepare path can refuse a video over claim support', () => {
  const prepare = src('lib/video-prepare.ts');
  // The refusals are enumerated in one block guarded by `defect.blocking`, and
  // the only two errors it can return are the two that existed before this
  // check. If a third appears, this assertion is the place to justify it.
  const errors = Array.from(prepare.matchAll(/error: '([a-z_]+)'/g)).map((m) => m[1]);
  assert.ok(!errors.includes('unsupported_citation'), 'an unsupported citation must never become a refusal');
});

test('the judge fails open, in the file that talks to the provider', () => {
  const ai = src('lib/ai.ts');
  const judge = ai.slice(ai.indexOf('export async function judgeClaimSupport'));
  assert.match(judge.slice(0, 4000), /catch[\s\S]*status: 'unchecked'/, 'a provider failure is never a verdict');
  // A model that cannot be reached must not be able to stop the clinic
  // publishing — the same call this codebase already makes for an unreachable
  // Crossref (lib/citation.ts 'unavailable').
  assert.match(judge.slice(0, 4000), /temperature: 0/, 'a verdict on a medical claim is not a creative act');
});

// A type-level guard: the stamp the panel reads is the stamp prepare writes.
const _verdicts: SupportVerdict[] = [{ status: 'supported', index: 0 }, { status: 'none' }, { status: 'unchecked' }];
assert.equal(_verdicts.length, 3);

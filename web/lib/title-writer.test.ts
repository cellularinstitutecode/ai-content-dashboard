// web/lib/title-writer.test.ts
//
// "Instead of the keyword search I want to make sure it drafts it with AI
//  taking into consideration what was said from the copy and the transcription
//  of the video."
//
// The title had come from two places, both outside the video: the file's name
// (which names whoever shot it — "Video_RyallxCellgenicxCellularInstitute_
// Rodrigo.mp4") and the keyword search (a search-volume ranking, which once
// described a nervous-system video as being about floating bed frames).
//
// The model that wrote the copy read the transcript to do it. This asks it for
// the title from the same material — and then trusts it exactly as far as a
// typed title is trusted, which is the half that matters: a suggestion, not a
// decision. Everything ambiguous falls back to the rung below rather than
// reaching a channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_TITLE_CHARS, TITLE_SYSTEM, readTitle, titlePrompt } from './title-writer.ts';
import { professionalTitle } from './post-title.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NO_ENV: Record<string, string | undefined> = {};

test('the model is given what was said AND what was written', () => {
  const prompt = titlePrompt({
    transcript: 'We manufacture peptide formulations in vials, pens and nasal sprays.',
    copy: 'Cellgenic Labs manufactures peptide formulations in multiple delivery methods…',
    subject: 'Video_RyallxCellgenic_Rodrigo.mp4',
  });
  assert.match(prompt, /WHAT THE SPEAKER SAID:/);
  assert.match(prompt, /vials, pens and nasal sprays/);
  assert.match(prompt, /THE POST WRITTEN FROM IT:/);
  // The file name is handed over labelled as unreliable rather than withheld:
  // sometimes it IS the subject, and the model can see which.
  assert.match(prompt, /may be unreliable/);
});

test('the instructions forbid the two things that must never reach a channel', () => {
  assert.match(TITLE_SYSTEM, /NEVER name a person/i);
  assert.match(TITLE_SYSTEM, /not in it|do not add a claim/i);
});

test('one clean line comes back, however it was wrapped', () => {
  assert.equal(readTitle('Peptide Formulations for Every Protocol'), 'Peptide Formulations for Every Protocol');
  assert.equal(readTitle('"Peptide Formulations"'), 'Peptide Formulations');
  assert.equal(readTitle('Title: Peptide Formulations'), 'Peptide Formulations');
  assert.equal(readTitle('**Peptide Formulations**\n\n(six words)'), 'Peptide Formulations');
  assert.equal(readTitle('Red Light Therapy.'), 'Red Light Therapy');
});

test('anything that is not a title is nothing, never a guess', () => {
  // Each of these, published, would be worse than the filename it replaced.
  const junk = [
    '',
    '   ',
    'I cannot write a title without more information.',
    'Sure! Here is a title:',
    'Sorry, I can only help with…',
    '#peptides #cellularinstitute',
    'https://example.com/video',
    '12345',
    'a'.repeat(MAX_TITLE_CHARS + 1),
  ];
  for (const t of junk) assert.equal(readTitle(t), '', JSON.stringify(t.slice(0, 40)));
});

test('a drafted title is still only a suggestion', () => {
  // It goes through the same door a typed one does: the clinic's name once…
  assert.equal(
    professionalTitle({ drafted: 'Peptide Formulations for Every Protocol', env: NO_ENV }).title,
    'Peptide Formulations for Every Protocol at Cellular Institute',
  );
  // …and a name from the strip list is refused even when the model wrote it.
  const named = professionalTitle({ drafted: 'Rodrigo Explains Peptides', keyword: 'peptide therapy', env: NO_ENV });
  assert.equal(named.source, 'keyword', 'the model does not get to publish a staff name');
  assert.ok(!named.title.includes('Rodrigo'));
});

test('it sits above the keyword and below a person', () => {
  const env = NO_ENV;
  assert.equal(professionalTitle({ supplied: 'My Own Title', drafted: 'Drafted One', env }).source, 'written');
  assert.equal(professionalTitle({ drafted: 'Drafted One', keyword: 'red light therapy', env }).source, 'drafted');
  // And when the writer gives nothing, the keyword still works exactly as before.
  assert.equal(professionalTitle({ drafted: '', keyword: 'red light therapy', env }).source, 'keyword');
});

// --- IT IS WIRED, AND IT FAILS OPEN ----------------------------------------

test('preparing a row writes the title from the transcript it just used', () => {
  const prepare = src('lib/video-prepare.ts');
  assert.match(prepare, /writeTitle\(\{/, 'prepareVideo must ask for a title');
  assert.match(prepare, /transcript: transcriptExcerpt\(transcript/, 'from the words that were actually said');
  assert.match(prepare, /drafted: draftedTitle/, 'and it must reach the title chain');
});

test('the composer writes the title from the draft’s transcript, not from Semrush', () => {
  const page = src('app/page.tsx');
  assert.match(page, /\/api\/title/, 'the composer must have a way to ask for one');
  assert.match(page, /draftId: mDraftId/, 'and must pass the draft so the transcript is read');
  assert.ok(!/Keyword search/.test(page), 'the keyword button was replaced, as asked');
});

test('a writer that does not answer never blocks anything', () => {
  const ai = src('lib/ai.ts');
  const fn = ai.slice(ai.indexOf('export async function writeTitle'));
  assert.match(fn.slice(0, 4000), /catch[\s\S]*return ''/, 'a provider failure is an empty title, not an error');
  const prepare = src('lib/video-prepare.ts');
  assert.match(prepare, /canCheckClaim\(remainingMs\(startedAt, budgetMs, Date\.now\(\)\)\)/, 'and it is skipped when the clock is short');
});

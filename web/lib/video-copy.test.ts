import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeCaption, forbiddenNames, houseStyleHint, keywordGrounding, namesLeaked, topicFromTranscript, transcriptExcerpt, videoSubject } from './video-copy.ts';

const AVISO = '2623022002A00090';

test('the keyword brief researches the subject, not the whole prompt', () => {
  // The bug: the entire instruction plus a 12,000-character transcript was
  // sent to Semrush as a literal search phrase, so every video came back with
  // no keyword data while the account sat on 48,000 unspent units.
  assert.equal(videoSubject('Reel_MolecularHydrogenRyall_Rodrigo.mp4'), 'Molecular Hydrogen');
  assert.equal(videoSubject('Reel_HyperbaricChamberRyall_Rodrigo.mp4'), 'Hyperbaric Chamber');
  assert.equal(videoSubject('Reel_PEMFxRyall_Rodrigo.mp4'), 'PEMF');
  assert.equal(videoSubject('Reel_TravelAbroadRyall_Rodrigo.mp4'), 'Travel Abroad');
});

test('take numbers, separators and the presenter tag out of the seed', () => {
  assert.equal(videoSubject('Reel_#4TPExRyall_Rodrigo.mp4'), 'TPE');
  assert.match(videoSubject('Reel_RedBlue&IfraRedLightxRyall_Rodrigo.mp4'), /Red Blue Ifra Red Light/);
  assert.equal(videoSubject('Reel_CosOfStemCellsRyall_Rodrigo.mp4'), 'Cos Of Stem Cells');
});

test('an unusable name falls back to what was actually said', () => {
  const transcript = 'Molecular hydrogen helps the body manage oxidative stress and inflammation. It is the smallest molecule.';
  const seed = videoSubject('', transcript);
  assert.match(seed, /Molecular hydrogen/);
  assert.ok(seed.split(' ').length <= 9, 'a seed is a phrase, not a paragraph: ' + seed);
});

test('a one-word subject is kept, not diluted', () => {
  // EBOO, PEMF and TPE are the searchable terms themselves. Treating them as
  // too short and appending the transcript's opening sentence would hand
  // Semrush a worse phrase than the file name already gave it.
  const transcript = 'What if something as simple as hydrogen could help your body manage oxidative stress?';
  assert.equal(videoSubject('Reel_EBOOxRyall_Rodrigo.mp4', transcript), 'EBOO');
  assert.equal(videoSubject('Reel_PEMFxRyall_Rodrigo.mp4', transcript), 'PEMF');
});

test('a seed is never the size of a prompt', () => {
  const huge = 'Write social copy for this published video. TRANSCRIPT: ' + 'word '.repeat(3000);
  assert.ok(videoSubject('Reel_EBOOxRyall_Rodrigo.mp4', huge).length < 40);
  assert.ok(videoSubject('', huge).length < 80, 'even the fallback stays a phrase');
});

test('exactly one AVISO survives, carrying the clinic’s own number', () => {
  // Straight from production: the writer invented a permit number, in a shape
  // the matcher did not recognise, so the real one was appended underneath and
  // the post carried both.
  const fromProduction = [
    'Ready to explore how molecular hydrogen fits into your wellness plan?',
    '',
    '#MolecularHydrogen #RegenerativeMedicine #CellularHealth',
    '',
    'REF: LeBaron, T.W., et al. (2019). "Molecular hydrogen as a novel antioxidant." Medical Gas Research, 9(4), 192–200. DOI: 10.4103/2045-9912.273959',
    '',
    'AVISO DE PUBLICIDAD COFEPRIS 2425N2SSA01827',
  ].join('\n');

  const out = composeCaption(fromProduction, AVISO);
  assert.equal((out.match(/AVISO DE PUBLICIDAD/gi) || []).length, 1, 'exactly one notice:\n' + out);
  assert.ok(out.includes('AVISO DE PUBLICIDAD: ' + AVISO));
  assert.ok(!out.includes('2425N2SSA01827'), 'the invented number must not survive');
});

test('the house order: body, REF, AVISO, hashtags last', () => {
  const out = composeCaption(
    'Body text here.\n\n#One #Two\n\nREF: Author, A. (2020). "Title." Journal. DOI: 10.1000/abc',
    AVISO,
  );
  const iRef = out.indexOf('REF:');
  const iAviso = out.indexOf('AVISO DE PUBLICIDAD');
  const iTags = out.indexOf('#One');
  assert.ok(iRef < iAviso, 'REF before the notice');
  assert.ok(iAviso < iTags, 'the notice before the hashtags');
  assert.ok(out.trim().endsWith('#One #Two'), 'hashtags last:\n' + out);
});

test('copy with no notice at all still gets exactly one', () => {
  const out = composeCaption('Just a body.\n\n#Tag', AVISO);
  assert.equal((out.match(/AVISO DE PUBLICIDAD/gi) || []).length, 1);
  assert.ok(out.trim().endsWith('#Tag'));
});

test('the topic comes from what was said, not what the file was called', () => {
  // The real case: "Reel_RyallCellgenicScript16_Rodrigo" reduces to a partner's
  // name and a script number, Semrush has no such phrase, and the Prepare
  // screen showed "NO keyword data" over copy written blind.
  const spoken =
    'Quality in regenerative medicine is not just about the cells. At Cellular Institute we work with ' +
    'Cellgenic, where cellular products are cultured under controlled conditions. Serious manufacturing ' +
    'in regenerative medicine means documenting every step, and patients deserve transparency.';
  assert.equal(topicFromTranscript(spoken), 'regenerative medicine');
});

test('a phrase said once is not a theme', () => {
  // Otherwise the seed is whatever happened to open the video.
  assert.equal(topicFromTranscript('the patient walked into the clinic today'), '');
});

test('a single repeated word is used when nothing is said twice as a pair', () => {
  assert.equal(topicFromTranscript('exosomes matter. exosomes again. something else entirely.'), 'exosomes');
});

test('an empty or wordless transcript yields nothing rather than noise', () => {
  assert.equal(topicFromTranscript(''), '');
  assert.equal(topicFromTranscript('the a of to in on'), '');
  assert.equal(topicFromTranscript('... 123 456 ...'), '');
});

test('the furniture set is less grounded than the one the video is about', () => {
  // Verbatim from Semrush for the seed "floating bed", and verbatim from the
  // Prepare screen that shipped them. Every one is a real phrase with real
  // volume — "floating bed frame" gets 12,100 searches a month — and every one
  // is about buying a bedstead.
  const furniture = [
    'floating bed frame', 'floating beds', 'windbed', 'hanging bed',
    'floating bed frame queen', 'diy floating bed frame', 'floating bedroom',
  ];
  const spoken =
    'What if 20 minutes could help you shift from go-go-go to true rest and reset? ' +
    'Our floating bed offers a 20-minute nervous system reset. The grounding sensation ' +
    'of water helps you shift out of fight-or-flight and into deep rest.';
  const onTopic = [
    'vagus nerve reset', 'nervous system dysregulation', 'how to regulate nervous system',
    'nervous system regulation', 'dysregulated nervous system',
  ];
  // What the pipeline decides on: which seed the video actually supports.
  // Neither clears any absolute bar — Semrush returns related terms beyond
  // what is said, in both sets — so an absolute threshold would have discarded
  // the right answer with the wrong one. Measured: 0.25 against 0.33.
  assert.ok(
    keywordGrounding(furniture, spoken) < keywordGrounding(onTopic, spoken),
    'frame, queen, diy and bedroom are never said; nervous, system and reset are',
  );
});

test('a set drawn from the words themselves grounds completely', () => {
  const spoken = 'Our floating bed offers a nervous system reset and deep rest.';
  assert.equal(keywordGrounding(['nervous system reset', 'deep rest'], spoken), 1);
});

test('scoring is per WORD, so one shared phrase cannot carry the rest', () => {
  // The trap: "floating bed" IS said. Matching whole phrases would pass the
  // entire furniture set on the strength of it.
  const spoken = 'our floating bed is a nervous system reset';
  assert.equal(keywordGrounding(['floating bed frame queen'], spoken), 0.5, 'frame and queen are not said');
  assert.equal(keywordGrounding(['floating bed'], spoken), 1);
});

test('plurals are the same word', () => {
  assert.equal(keywordGrounding(['exosomes'], 'we use exosome therapy'), 1);
});

test('nothing to compare against grounds nothing', () => {
  assert.equal(keywordGrounding(['anything'], ''), 0);
  assert.equal(keywordGrounding([], 'a transcript with words in it'), 0);
});

test('the copy may never name the person the file belongs to', () => {
  // Verbatim from the post that shipped. Rodrigo uploads the videos; the clinic
  // published a testimonial from a patient who does not exist.
  const shipped = 'As our patient Rodrigo shares: "It\'s nice to press pause…"';
  assert.deepEqual(namesLeaked(shipped, ['Rodrigo', 'Ryall']), ['Rodrigo']);
  // What the clinic's own writer does, and what the prompt now asks for.
  assert.deepEqual(namesLeaked('As one patient put it: "It\'s nice to press pause…"', ['Rodrigo', 'Ryall']), []);
});

test('a name is caught however it is cased or possessive, but not inside another word', () => {
  assert.deepEqual(namesLeaked('RODRIGO said so', ['Rodrigo']), ['Rodrigo']);
  assert.deepEqual(namesLeaked("Rodrigo's session", ['Rodrigo']), ['Rodrigo']);
  // "Ryall" must not fire on "Ryalls­tone"-style words, nor "Ana" on "analysis".
  assert.deepEqual(namesLeaked('a full analysis of the sample', ['Ana']), []);
});

test('the forbidden names come from the same conventions the subject strips', () => {
  assert.deepEqual(forbiddenNames('Reel_FloatingBedRyall_Rodrigo').sort(), ['Rodrigo', 'Ryall']);
  assert.deepEqual(forbiddenNames('CI_HyperbaricOxygenTherapy_Sebas'), ['Sebas']);
  // A title with no owner suffix forbids nothing, and the creator column can add one.
  assert.deepEqual(forbiddenNames('Safety Matters'), []);
  assert.deepEqual(forbiddenNames('Safety Matters', 'Teresa'), ['Teresa']);
});

test('a transcript is cut at a sentence, and says that it was cut', () => {
  const long = 'One sentence here. Two sentences here. And a third that runs on and on and on.';
  const cut = transcriptExcerpt(long, 45);
  assert.ok(cut.startsWith('One sentence here. Two sentences here.'), cut);
  assert.ok(!/here\s+Two/.test(cut), 'the sentence boundary is kept');
  assert.match(cut, /Transcript truncated here/);
  // Short enough to fit is returned whole, with no marker bolted on.
  assert.equal(transcriptExcerpt('Short.', 500), 'Short.');
});

test('the house style states the numbers measured from the real posts', () => {
  const h = houseStyleHint();
  assert.match(h, /800-1,100 characters/);
  assert.match(h, /10-11, all lowercase/);
  assert.match(h, /#cellularinstitute/);
  assert.match(h, /Do not open with a question/);
  // The rule the thinness actually turns on.
  assert.match(h, /name at least three concrete things the speaker actually said/);
});

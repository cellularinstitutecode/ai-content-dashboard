import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeCaption, videoSubject } from './video-copy.ts';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanVideoTitle, looksLikeFilename } from './video-title.ts';

test('the clinic’s real filenames become titles a clinic would publish', () => {
  // These are the actual files. Every one of them was going onto YouTube and
  // TikTok verbatim, so the channels carried two staff names and a "Reel_".
  const cases: [string, string][] = [
    ['Reel_RyallHBOT_Rodrigo', 'HBOT at Cellular Institute'],
    ['Reel_RedLightRyall_Rodrigo', 'Red Light at Cellular Institute'],
    ['Reel_Shoulder2Ryall_Rodrigo.mp4', 'Shoulder at Cellular Institute'],
    ['Reel_RyallOxygenCircuit_Rodrigo', 'Oxygen Circuit at Cellular Institute'],
    ['Video_FinalCompCorporativo_Rodrigo', 'Corporativo at Cellular Institute'],
    ['Reel_RyallRedLightTherapy_Rodrigo', 'Red Light Therapy at Cellular Institute'],
  ];
  for (const [file, want] of cases) assert.equal(cleanVideoTitle(file), want, file);
});

test('no staff name survives, in any position', () => {
  for (const file of ['Reel_RyallHBOT_Rodrigo', 'Rodrigo_HBOT', 'HBOT_Ryall.mp4', 'RyallRodrigoHBOT']) {
    const out = cleanVideoTitle(file);
    assert.doesNotMatch(out, /rodrigo/i, file);
    assert.doesNotMatch(out, /ryall/i, file);
  }
});

test('nothing internal survives either — no extension, no Reel_, no stray numbers', () => {
  for (const file of ['Reel_RedLightRyall_Rodrigo.mp4', 'Video_RedLight2_Rodrigo.mov']) {
    const out = cleanVideoTitle(file);
    assert.doesNotMatch(out, /\.(mp4|mov)/i, file);
    assert.doesNotMatch(out, /^Reel|^Video\b/i, file);
    assert.doesNotMatch(out, /_/, file);
    assert.doesNotMatch(out, /\d/, file);
  }
});

test('the names to strip are a setting, not a hardcoded list', () => {
  // The next editor will have a different name and nobody should need a deploy.
  const env = { VIDEO_TITLE_STRIP: 'Maria, Lopez' };
  assert.equal(cleanVideoTitle('Reel_MariaRedLight_Lopez', { env }), 'Red Light at Cellular Institute');
  // With that setting, the old names are no longer stripped — the list IS the rule.
  assert.match(cleanVideoTitle('Reel_RodrigoHBOT', { env }), /Rodrigo/);
});

test('a file with no subject left falls back rather than publishing nonsense', () => {
  assert.equal(cleanVideoTitle('Reel_Rodrigo.mp4'), 'Cellular Institute');
  assert.equal(cleanVideoTitle(''), 'Cellular Institute');
  assert.equal(cleanVideoTitle(null), 'Cellular Institute');
});

test('acronyms keep shouting; everything else is Title Case', () => {
  assert.match(cleanVideoTitle('Reel_RyallHBOT_Rodrigo'), /^HBOT /);
  assert.match(cleanVideoTitle('Reel_PRPKnee_Rodrigo'), /^PRP Knee/);
  assert.equal(cleanVideoTitle('reel_redlight_rodrigo'), 'Redlight at Cellular Institute');
});

test('the suffix can be turned off for a caller that adds its own', () => {
  assert.equal(cleanVideoTitle('Reel_RedLightRyall_Rodrigo', { suffix: '' }), 'Red Light');
  assert.equal(cleanVideoTitle('Reel_RedLightRyall_Rodrigo', { suffix: 'Cellular Hope' }), 'Red Light at Cellular Hope');
});

test('a written title is told apart from a filename', () => {
  assert.equal(looksLikeFilename('Reel_RyallHBOT_Rodrigo'), true);
  assert.equal(looksLikeFilename('video.mp4'), true);
  assert.equal(looksLikeFilename('Red Light Therapy at Cellular Institute'), false);
  assert.equal(looksLikeFilename(''), false);
});

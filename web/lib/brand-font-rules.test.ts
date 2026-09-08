import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFontFile, isTrialFont, isVariableFont, validateFontUpload, coverage, MAX_FONT_BYTES } from './brand-font-rules.ts';

test('family, role, weight and style are read from the file name', () => {
  assert.deepEqual(describeFontFile('Rische-Semibold.otf'), { family: 'Rische', role: 'body', weight: 600, style: 'normal' });
  assert.deepEqual(describeFontFile('Canela-Medium.otf'), { family: 'Canela', role: 'headline', weight: 500, style: 'normal' });
  assert.deepEqual(describeFontFile('NexaText-BoldItalic.otf'), { family: 'Nexa', role: 'body', weight: 700, style: 'italic' });
  assert.deepEqual(describeFontFile('Rische-Light.otf'), { family: 'Rische', role: 'body', weight: 300, style: 'normal' });
  assert.equal(describeFontFile('Helvetica.ttf'), null, 'not a brand face');
  assert.equal(describeFontFile('Rische-Regular.zip'), null, 'not a font file');
});

test('trial and demo builds are recognised whatever the family', () => {
  for (const n of ['Nexa-Trial-Bold.otf', 'NexaDemo-Light.otf', 'NexaTextDemo-Bold.otf', 'CanelaTextTrial-Medium.otf']) {
    assert.equal(isTrialFont(n), true, n);
  }
  assert.equal(isTrialFont('Rische-Regular.otf'), false);
  assert.equal(isTrialFont('Nexa-Bold.otf'), false);
});

test('uploads: the purchased Rische family is accepted, trial Nexa is refused with the reason, junk is refused', () => {
  const ok = validateFontUpload('Rische-Regular.otf', 24_576);
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.file.family, 'Rische'); assert.equal(ok.safeName, 'Rische-Regular.otf'); }
  const trial = validateFontUpload('Nexa-Trial-Bold.otf', 54_204);
  assert.equal(trial.ok, false);
  if (!trial.ok) assert.match(trial.reason, /trial\/demo/);
  const other = validateFontUpload('Comic.ttf', 1000);
  assert.equal(other.ok, false);
  if (!other.ok) assert.match(other.reason, /Canela, Nexa, Rische/);
  assert.equal(validateFontUpload('Rische-Regular.otf', 0).ok, false);
  assert.equal(validateFontUpload('Rische-Regular.otf', MAX_FONT_BYTES + 1).ok, false);
  assert.equal(validateFontUpload('Rische-Regular.pdf', 5000).ok, false);
  const pathy = validateFontUpload('../../etc/Rische Bold (1).otf', 5000);
  assert.equal(pathy.ok, true);
  if (pathy.ok) assert.equal(pathy.safeName, 'Rische_Bold__1_.otf', 'stored under a name with no path or odd characters');
});

test('coverage says which role still runs on a stand-in', () => {
  assert.deepEqual(coverage([]), { headline: null, body: null, standInFaces: ['headline', 'body'] });
  assert.deepEqual(coverage(['Rische-Regular.otf', 'Rische-Bold.otf']), { headline: null, body: 'Rische', standInFaces: ['headline'] });
  assert.deepEqual(coverage(['Rische-Regular.otf', 'Nexa-Bold.otf']).body, 'Nexa', 'Nexa outranks Rische for the body when both are licensed');
  assert.deepEqual(coverage(['Rische-Regular.otf', 'Nexa-Trial-Bold.otf']).body, 'Rische', 'a trial Nexa does not count');
  assert.deepEqual(coverage(['Canela-Regular.otf', 'Rische-Regular.otf']).standInFaces, []);
});

test('a variable font file is recognised so the renderer can prefer the static weights', () => {
  assert.equal(isVariableFont('Rische-Variable.ttf'), true);
  assert.equal(isVariableFont('Canela[wght].ttf'), true);
  assert.equal(isVariableFont('Rische-Regular.otf'), false);
  assert.equal(validateFontUpload('Rische-Variable.ttf', 40_000).ok, true, 'it is still accepted and listed');
});

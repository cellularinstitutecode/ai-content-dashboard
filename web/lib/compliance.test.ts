// The advertising rule is enforced at three doors and shown in two panels;
// they all call these functions, so this is where the rule itself is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AVISO_NUMBER,
  appliesTo,
  avisoLine,
  avisoNumberFor,
  checkCompliance,
  ensureAviso,
  complianceMessage,
} from './compliance.ts';

const GOOD =
  'Before thinking about supplements, look at your plate.\n\n#cellularinstitute #nutrition\n\n' +
  'REF: Djuricic, I., & Calder, P.C. (2021). "Beneficial Outcomes of Omega-6 and Omega-3 Polyunsaturated Fatty Acids on Human Health." Nutrients, 13(7), 2421. DOI: 10.3390/nu13072421\n\n' +
  'AVISO DE PUBLICIDAD: 2623022002A00090';

test('the rule applies to every network the clinic advertises on', () => {
  assert.equal(appliesTo(['instagram']), true);
  assert.equal(appliesTo(['facebook', 'linkedin']), true);
  assert.equal(appliesTo('instagram'), true);
  // LinkedIn and TikTok were outside this set, so the gate answered "does not apply" for
  // the two networks the video pipeline actually publishes to. Advertising a clinic's
  // therapies in Mexico does not stop being advertising because the post is on LinkedIn.
  assert.equal(appliesTo(['linkedin']), true);
  assert.equal(appliesTo(['tiktok']), true);
  // A therapeutic claim in a video description is still advertising.
  assert.equal(appliesTo(['youtube']), true);
  assert.equal(appliesTo(['twitter', 'blog']), false);
  assert.equal(appliesTo([]), false);
  assert.equal(appliesTo(null), false);
});

test('a caption with both lines passes, and the DOI is extracted from the REF line', () => {
  const c = checkCompliance(GOOD);
  assert.equal(c.ok, true);
  assert.deepEqual(c.missing, []);
  assert.equal(c.avisoFound, DEFAULT_AVISO_NUMBER);
  assert.equal(c.doi, '10.3390/nu13072421');
  assert.match(c.ref || '', /^Djuricic/);
});

test('each missing line is named; a bare "REF:" label does not count as a citation', () => {
  const noAviso = checkCompliance(GOOD.replace(/\n\nAVISO.*$/, ''));
  assert.deepEqual(noAviso.missing, ['aviso']);
  const noRef = checkCompliance('Great tips.\n\nAVISO DE PUBLICIDAD: 2623022002A00090');
  assert.deepEqual(noRef.missing, ['ref']);
  const bareRef = checkCompliance('Great tips.\n\nREF:\n\nAVISO DE PUBLICIDAD: 2623022002A00090');
  assert.deepEqual(bareRef.missing, ['ref']);
  const neither = checkCompliance('Great tips.');
  assert.deepEqual(neither.missing, ['aviso', 'ref']);
  assert.match(complianceMessage(neither), /advertising notice/);
  assert.match(complianceMessage(neither), /scientific reference/);
});

test('the wrong permit number is a mismatch, not compliance', () => {
  const c = checkCompliance(GOOD.replace('2623022002A00090', '9999999999X00001'));
  assert.equal(c.ok, false);
  assert.equal(c.avisoMismatch, true);
  assert.deepEqual(c.missing, ['aviso']);
  assert.match(complianceMessage(c), /different permit number/);
});

test('ensureAviso appends once, corrects a wrong number, and leaves a correct line alone', () => {
  const base = 'Hello world.\n\nREF: Some study (2020). Journal. DOI: 10.1000/xyz';
  const once = ensureAviso(base);
  assert.equal(once, base + '\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER);
  assert.equal(ensureAviso(once), once);
  const fixed = ensureAviso(once.replace(DEFAULT_AVISO_NUMBER, 'WRONG0000001'));
  assert.equal(fixed, once);
  assert.equal(ensureAviso(''), avisoLine(null));
});

test('the permit number resolves Brand Brain → environment → default', () => {
  const prev = process.env.AVISO_PUBLICIDAD;
  delete process.env.AVISO_PUBLICIDAD;
  assert.equal(avisoNumberFor(null), DEFAULT_AVISO_NUMBER);
  process.env.AVISO_PUBLICIDAD = 'envnumber0001';
  assert.equal(avisoNumberFor(''), 'ENVNUMBER0001');
  assert.equal(avisoNumberFor('brandnum00002'), 'BRANDNUM00002');
  if (prev === undefined) delete process.env.AVISO_PUBLICIDAD; else process.env.AVISO_PUBLICIDAD = prev;
});

test('the AVISO line is recognised with a full-width colon and extra spaces', () => {
  // A DOI-shaped DOI: '10.1/abc' never matched DOI_RE (which wants 4-9 digits after the
  // '10.'), so this fixture only passed while a REF without a usable DOI still counted.
  const c = checkCompliance('x\n\nREF: A real study (2021). Journal, 1(1), 1. DOI: 10.1080/00332747.1974.11023785\nAVISO  DE  PUBLICIDAD： 2623022002A00090');
  assert.equal(c.ok, true);
});

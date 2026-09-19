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
  complianceNetworksLabel,
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
  // And the blog, which used to be outside the set and was therefore the ONE
  // format that skipped the AVISO and the citation — while being the
  // longest-lived thing the clinic publishes, on its own domain, indexed, long
  // after a post has scrolled away. Same reasoning as LinkedIn's, one format
  // later: an 800-word article making a therapeutic claim is advertising.
  assert.equal(appliesTo(['blog']), true);
  assert.equal(appliesTo(['blog', 'instagram']), true);
  // Twitter stays outside it: the clinic does not advertise there, and adding
  // a channel to this set without also stamping its copy (lib/ai.ts) is how a
  // format arrives missing the line it is about to be refused for.
  assert.equal(appliesTo(['twitter']), false);
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

test('a REF line with no DOI is reported as a DOI problem, not a missing line', () => {
  // THE MESSAGE THAT SENT PEOPLE HUNTING. A caption with a perfectly good REF
  // line and no DOI used to report 'ref' — "add a REF line" — while the line
  // was already sitting there in front of them.
  const withRef = 'A claim about therapy.\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER
    + '\nREF: Smith, A.B. (2024). A study of something. Journal of Things, 12(3), 45-60.';
  const check = checkCompliance(withRef);
  assert.equal(check.ok, false);
  assert.ok(check.missing.includes('doi'), 'the DOI is what is missing');
  assert.ok(!check.missing.includes('ref'), 'the REF line is present and must not be reported as absent');
  assert.ok(check.ref, 'the line itself was found');
  assert.equal(check.doi, null);
});

test('no REF line at all is still reported as a missing line', () => {
  const noRef = 'A claim.\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER;
  const check = checkCompliance(noRef);
  assert.ok(check.missing.includes('ref'));
  assert.ok(!check.missing.includes('doi'), 'one problem, one name — never both');
});

test('a REF line with a DOI passes', () => {
  const good = 'A claim.\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER
    + '\nREF: Smith, A.B. (2024). A study. Journal, 12(3), 45-60. DOI: 10.1016/j.example.2024.01.001';
  const check = checkCompliance(good);
  assert.deepEqual(check.missing, []);
  assert.equal(check.ok, true);
  assert.equal(check.doi, '10.1016/j.example.2024.01.001');
});

test('the refusal names the networks the rule actually covers', () => {
  // The assertion that keeps the wording honest the next time SOCIAL_NETWORKS
  // changes. Every id in the set must be nameable, or a message will quietly
  // omit the network somebody is actually posting to.
  for (const id of ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube']) {
    assert.ok(appliesTo([id]), id + ' is covered by the rule');
    const named = complianceNetworksLabel([id]);
    assert.ok(named && named !== 'These', id + ' has no proper name in the label');
  }
  assert.equal(complianceNetworksLabel(['linkedin', 'youtube', 'tiktok']), 'LinkedIn, YouTube and TikTok');
  assert.equal(complianceNetworksLabel(['linkedin']), 'LinkedIn');
  // A network outside the rule contributes nothing to the sentence.
  assert.equal(complianceNetworksLabel(['twitter']), 'These');
  assert.match(complianceNetworksLabel(), /Instagram/);
  assert.match(complianceNetworksLabel(), /YouTube/);
});

test('the refused sentence names the selected networks, not two it is not about', () => {
  const noRef = checkCompliance('A claim.\n\nAVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER);
  const said = complianceMessage(noRef, ['linkedin', 'youtube', 'tiktok']);
  assert.match(said, /^LinkedIn, YouTube and TikTok posts/);
  assert.doesNotMatch(said, /Instagram/, 'it must not name a network the person is not posting to');
});

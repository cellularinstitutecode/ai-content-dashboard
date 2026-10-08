import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makesHealthClaim } from './health-claim.ts';
import { checkCompliance, refPolicyOf } from './compliance.ts';
import { pillarById } from './content-strategy.ts';
import { citationPolicyFor, strategyBrand } from './strategy-voice.ts';

const AVISO = 'AVISO DE PUBLICIDAD: 2623022002A00090';
const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a destination or logistics post makes no health claim', () => {
  for (const t of [
    'Cancun has direct flights from many US and Canadian cities, so getting here is simple.',
    'Plenty of hotels sit a short drive from the clinic, from quiet boutique stays to family resorts.',
    'Travelling with someone? Your companion can explore the old town or the beach while you are with us.',
    'Plan your open days: a boat trip, a museum, a slow lunch by the water.',
  ]) assert.equal(makesHealthClaim(t), false, t);
});

test('anything that sounds like a health claim counts, when unsure yes', () => {
  for (const t of [
    'Warm weather and rest can help the body recover after treatment.',
    'Studies show sea air reduces stress.',
    'Gentle walks on the beach support circulation.',
    'Stem cell therapy reduces knee pain in most patients.',
    'Our protocols are safe and 90% of patients see results.',
    'According to a 2022 study, red light speeds up healing.',
    'Exosomes may help the body recover faster.',
  ]) assert.equal(makesHealthClaim(t), true, t);
});

test('naming a therapy, a condition or a part of the body is not a claim — asserting what it does is', () => {
  // A reel asking what to ask a clinic: every sentence names a therapy, cells, a
  // protocol or a condition, and none asserts an effect. It was held for a
  // citation it had nothing to cite.
  const askTheClinic = 'One clinic may quote you $1,000. Another may quote $5,000 or more. But before assuming one is overpriced, look at what you are actually receiving. '
    + 'Is it simply an injection? What type of cells are being used? Has a physician reviewed your case? Are diagnostics included? Is there a personalized protocol built around your condition? '
    + 'Two clinics can both call what they offer "stem cell therapy" while providing completely different products and levels of care.';
  assert.equal(makesHealthClaim(askTheClinic), false);
  for (const t of [
    'HBOT sessions fit easily into an open day.',
    'Bring your diagnostics and your medication list to the first consultation.',
    'Our support team will meet you at the airport and take you to the clinic.',
    'The treatment room has a sea view.',
  ]) assert.equal(makesHealthClaim(t), false, t);
  // The same words, asserting something: a claim.
  for (const t of [
    'HBOT sessions reduce swelling.',
    'The treatment is safe.',
    'Stem cells repair cartilage.',
  ]) assert.equal(makesHealthClaim(t), true, t);
});

test('the REF line is waived only under the policy AND with no claim in the text', () => {
  const trip = 'Cancun has direct flights from many US and Canadian cities.\n\n' + AVISO;
  assert.equal(checkCompliance(trip).ok, false, 'the default policy still requires it');
  const waived = checkCompliance(trip, undefined, { refPolicy: 'if-health-claim' });
  assert.equal(waived.ok, true);
  assert.equal(waived.refWaived, true);
  const claim = 'Warm weather helps the body recover faster.\n\n' + AVISO;
  const held = checkCompliance(claim, undefined, { refPolicy: 'if-health-claim' });
  assert.equal(held.ok, false, 'a claim under the relaxed policy still needs its citation');
  assert.deepEqual(held.missing, ['ref']);
  // And the AVISO is required under every policy.
  assert.equal(checkCompliance('Direct flights from Toronto.', undefined, { refPolicy: 'if-health-claim' }).ok, false);
});

test('the policy is read from the draft, and anything unknown is "required"', () => {
  assert.equal(refPolicyOf({ _compliance: { refPolicy: 'if-health-claim' } }), 'if-health-claim');
  assert.equal(refPolicyOf({ _compliance: { refPolicy: 'whatever' } }), 'required');
  assert.equal(refPolicyOf(null), 'required');
});

test('every template cites a study when the post makes a health claim, and not otherwise', () => {
  // The rule is the clinic's, not the slot's: it used to be 'required' for all
  // but the destination slots, so informational posts cited studies that did
  // not back them and Fix citation could not remove them.
  assert.equal(citationPolicyFor({ seeded: 'weekly-strategy', slot: 'thu-2' }), 'if-health-claim');
  assert.equal(citationPolicyFor({ seeded: 'weekly-strategy', slot: 'tue-1' }), 'if-health-claim');
  assert.equal(citationPolicyFor({ slot: 'thu-2' }), 'if-health-claim', 'a hand-written template follows the same rule');
  assert.equal(citationPolicyFor(null), 'if-health-claim');
  assert.match(String(strategyBrand({ guidelines: '' } as Record<string, unknown>, { citation: 'if-health-claim' }).guidelines), /only if the post makes a health claim/);
  assert.match(String(strategyBrand({ guidelines: '' } as Record<string, unknown>).guidelines), /cite one real, relevant study\.$/);
  // The destination angles the policy exists for.
  for (const a of ['Air connectivity from the United States and Canada', 'Hotel, dining, and low-impact activity options', 'What a companion can do during the trip']) {
    assert.ok(pillarById('cancun')!.angles.concat(pillarById('recovery-cancun')!.angles).includes(a), a);
  }
});

test('wiring: every gate that re-checks stored copy reads the draft\'s policy', () => {
  assert.match(src('app/api/posts/route.ts'), /complianceGate\(user\.id, String\(existing\.text \|\| ''\), metricoolNetworks\(existing\.providers\), \{ refPolicy: refPolicyOf\(draftPack\), claimSupport: claimSupportOf\(draftPack\), citationAsRemark: true \}\)/);
  assert.match(src('app/api/metricool/schedule/route.ts'), /complianceGate\(user\.id, text, network, \{ refPolicy: draftRefPolicy, claimSupport: draftClaimSupport, citationAsRemark: true \}\)/);
  // The sweep's own hand-off to Metricool reads the same policy: a video post
  // rewritten to claim nothing (lib/video-prepare.ts rung 4) carries no REF
  // line on purpose, and this door used to refuse it for exactly that.
  assert.match(src('lib/video-publish.ts'), /complianceGate\(input\.userId, text, network, \{ refPolicy: refPolicyOf\(pack\), claimSupport: claimSupportOf\(pack\) \}\)/);
  const ap = src('lib/autopilot.ts');
  assert.match(ap, /refPolicy,\n/, 'approveRun plans each network under the template\'s policy');
  assert.match(ap, /claimSupport: \(pack\?\._claimSupport as \{ status\?: string \} \| undefined\)\?\.status \?\? null/, 'the judge\'s verdict reaches autoschedule');
  assert.doesNotMatch(ap, /claimSupport: null,/);
  assert.match(src('lib/ai.ts'), /citationPolicy === 'if-health-claim' \? REF_IF_CLAIM_INSTRUCTION : REF_INSTRUCTION/);
});

test('the clinic\'s own name is not a health claim', () => {
  // "Cellular" in the name matched the body-word list, so a logistics post
  // naming the team lost its waiver and was refused at approval.
  assert.equal(makesHealthClaim('Cellular Institute is a team in Cancun. Direct flights from the US and Canada make the trip simple.'), false);
  assert.equal(makesHealthClaim('The Cellular Hope Institute team will meet you at the airport.'), false);
  assert.equal(makesHealthClaim('Your cells repair overnight.'), true);
  assert.equal(makesHealthClaim('Supports cellular health.'), true);
  const trip = 'Cellular Institute is a team in Cancun. Direct flights from Toronto.\n\nAVISO DE PUBLICIDAD: 2623022002A00090';
  assert.equal(checkCompliance(trip, undefined, { refPolicy: 'if-health-claim' }).ok, true);
});

test('a Cancun post is not handed study abstracts to cite', () => {
  assert.match(src('lib/autopilot.ts'), /if \(strategySlot && citationPolicy === 'required'\) \{\s*try \{ evidence = await findEvidence/);
});

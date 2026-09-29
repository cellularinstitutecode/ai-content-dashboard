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
    'HBOT sessions fit easily into an open day.',
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

test('only the weekly strategy\'s destination slots are relaxed', () => {
  assert.equal(citationPolicyFor({ seeded: 'weekly-strategy', slot: 'thu-2' }), 'if-health-claim');
  assert.equal(citationPolicyFor({ seeded: 'weekly-strategy', slot: 'sun-2' }), 'if-health-claim');
  assert.equal(citationPolicyFor({ seeded: 'weekly-strategy', slot: 'tue-1' }), 'required');
  assert.equal(citationPolicyFor({ slot: 'thu-2' }), 'required', 'a hand-written template is never relaxed');
  assert.match(String(strategyBrand({ guidelines: '' } as Record<string, unknown>, { citation: 'if-health-claim' }).guidelines), /only if the post makes a health claim/);
  assert.match(String(strategyBrand({ guidelines: '' } as Record<string, unknown>).guidelines), /cite one real, relevant study\.$/);
  // The destination angles the policy exists for.
  for (const a of ['Air connectivity from the United States and Canada', 'Hotel, dining, and low-impact activity options', 'What a companion can do during the trip']) {
    assert.ok(pillarById('cancun')!.angles.concat(pillarById('recovery-cancun')!.angles).includes(a), a);
  }
});

test('wiring: every gate that re-checks stored copy reads the draft\'s policy', () => {
  assert.match(src('app/api/posts/route.ts'), /complianceGate\(user\.id, String\(existing\.text \|\| ''\), metricoolNetworks\(existing\.providers\), \{ refPolicy: refPolicyOf\(draftPack\), claimSupport: claimSupportOf\(draftPack\) \}\)/);
  assert.match(src('app/api/metricool/schedule/route.ts'), /complianceGate\(user\.id, text, network, \{ refPolicy: draftRefPolicy, claimSupport: draftClaimSupport \}\)/);
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

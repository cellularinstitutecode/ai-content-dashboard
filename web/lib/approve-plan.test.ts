import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { channelCopy, doisIn, knownBadCitation, perNetworkPlan } from './approve-plan.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const REF = 'REF: Smith, A., et al. (2020). "Protein and recovery." J Nutr, 1(2), 3-4. DOI: 10.1000/abc123';
const AVISO = '2623022002A00090';

const pack = {
  instagram: 'IG: protein matters.\n#protein\n\n' + REF,
  facebook: 'FB: a longer, warmer post about protein.\n\n' + REF,
  linkedin: 'LI: protein and recovery, for professionals.\n\n' + REF,
};

test('every network gets its own copy, with the AVISO stamped', () => {
  const plan = perNetworkPlan(pack, ['instagram', 'facebook', 'linkedin'], { aviso: AVISO });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.sends.map((s) => s.network), ['instagram', 'facebook', 'linkedin']);
  assert.match(plan.sends[0].text, /^IG:/);
  assert.match(plan.sends[1].text, /^FB:/);
  assert.match(plan.sends[2].text, /^LI:/, 'LinkedIn no longer gets the Instagram caption');
  for (const s of plan.sends) assert.match(s.text, /AVISO DE PUBLICIDAD: 2623022002A00090/);
});

test('one network that fails the rule refuses the whole send, naming it', () => {
  const plan = perNetworkPlan({ ...pack, linkedin: 'LI: no citation here at all.' }, ['instagram', 'facebook', 'linkedin'], { aviso: AVISO });
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.network, 'linkedin');
  assert.match(!plan.ok ? plan.reason : '', /LinkedIn/);
});

test('copy that is too long for its network is refused before anything goes', () => {
  const plan = perNetworkPlan({ ...pack, instagram: 'x'.repeat(2300) + '\n\n' + REF }, ['instagram'], { aviso: AVISO });
  assert.equal(plan.ok, false);
  assert.match(!plan.ok ? plan.reason : '', /over its limit/);
});

test('a network the writer does not write for takes the Instagram caption', () => {
  assert.match(channelCopy(pack, 'tiktok'), /^IG:/);
  assert.match(channelCopy(pack, 'facebook'), /^FB:/);
  assert.equal(channelCopy({ blog: 'article' }, 'blog'), 'article');
});

test('a DOI Crossref already said does not exist is caught; a different one is not', () => {
  const plan = perNetworkPlan(pack, ['instagram', 'facebook'], { aviso: AVISO });
  assert.ok(plan.ok);
  const sends = plan.ok ? plan.sends : [];
  assert.deepEqual(doisIn(sends), ['10.1000/abc123']);
  assert.equal(knownBadCitation({ citation: { status: 'not_found', doi: '10.1000/ABC123' } }, sends), '10.1000/ABC123');
  assert.equal(knownBadCitation({ citation: { status: 'not_found', doi: '10.9999/other' } }, sends), null);
  assert.equal(knownBadCitation({ citation: { status: 'verified', doi: '10.1000/abc123' } }, sends), null);
  assert.equal(knownBadCitation(null, sends), null);
});

test('wiring: approveRun sends one post per network, checked before the first goes', () => {
  const ap = src('lib/autopilot.ts');
  const approve = ap.slice(ap.indexOf('export async function approveRun'));
  const planAt = approve.indexOf('perNetworkPlan(');
  const sendAt = approve.indexOf('await metricoolSchedulePost(');
  assert.ok(planAt > 0 && sendAt > planAt, 'every network is planned before any is sent');
  assert.match(approve, /for \(const send of sends\) \{/);
  assert.match(approve, /providers: \[send\.network as McNetwork\]/, 'one network per post');
  assert.doesNotMatch(approve, /let text = channelText\(pack, mcProviders\[0\]/, 'the single shared caption is gone');
  assert.match(approve, /knownBadCitation\(stamp, sends\)/, 'a not-found DOI is refused at Approve');
  assert.match(approve, /BUT NOT EVERY NETWORK WENT/, 'a partial send is said, and not released');
});

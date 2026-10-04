import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAIM_REWRITE_STRICT_SYSTEM, CLAIM_REWRITE_SYSTEM, NO_CLAIM_SYSTEM, acceptNoClaim, acceptRewrite, claimRewritePrompt, noClaimPrompt, parseRelevance, relevancePrompt } from './claim-rewrite.ts';
import { healthClaimWords } from './health-claim.ts';

const POST = 'Stem cells repair knee cartilage completely.\n\nAsk us how.\n\nREF: Old et al. 2019. doi:10.1000/old\n\nAVISO DE PUBLICIDAD COFEPRIS 123';
const REF = 'REF: Smith J et al. Knee MSC trial. 2022. doi:10.5555/knee.2022';

test('the prompt carries the study, its REF line and the post, and the rules keep everything else', () => {
  const p = claimRewritePrompt(POST, { title: 'Knee MSC trial', year: 2022, abstract: 'Pain scores improved at 12 months.', ref: REF });
  assert.match(p, /Title: Knee MSC trial \(2022\)/);
  assert.match(p, /What it reports: Pain scores improved/);
  assert.match(p, /REF line to use: REF: Smith J et al\./, 'one REF label, not two');
  assert.match(p, /THE POST\nStem cells repair/);
  assert.match(CLAIM_REWRITE_SYSTEM, /Rewrite ONLY the sentence\(s\) that claim more than the study shows/);
  assert.match(CLAIM_REWRITE_SYSTEM, /AVISO DE PUBLICIDAD line/);
  assert.match(CLAIM_REWRITE_SYSTEM, /Never mention a cure/);
});

test('acceptRewrite: takes a rewrite that keeps the post, the AVISO and the new study', () => {
  const good = 'A 2022 study found knee pain improved after stem cell treatment.\n\nAsk us how.\n\nREF: Smith J et al. Knee MSC trial. 2022. doi:10.5555/knee.2022\n\nAVISO DE PUBLICIDAD COFEPRIS 123';
  assert.equal(acceptRewrite(POST, '```\n' + good + '\n```', REF), good, 'fences are stripped');
  assert.equal(acceptRewrite(POST, good.replace(/\n\nAVISO[\s\S]*$/, ''), REF), null, 'the AVISO cannot be dropped');
  assert.equal(acceptRewrite(POST, good.replace('10.5555/knee.2022', '10.1000/old'), REF), null, 'it must cite the new study');
  assert.equal(acceptRewrite(POST, 'Short.', REF), null, 'not a different, shorter post');
  assert.equal(acceptRewrite(POST, good + '\n' + good, REF), null, 'not a different, longer post');
  assert.equal(acceptRewrite(POST, '', REF), null);
});

test('Fix citation never redrafts the post or touches the picture', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const autopilot = src('lib/autopilot.ts');
  const body = autopilot.slice(autopilot.indexOf('export async function fixCitationOnly('), autopilot.indexOf('/** Write the step FIX is on'));
  assert.ok(body.length > 200, 'fixCitationOnly exists');
  assert.doesNotMatch(body, /regenerateRun\(|advanceRuns\(|ensureDraftImage\(/, 'no redraft and no new picture');
  assert.match(body, /fixCitation\(db, run, pack, aviso\)/, 'rung 1: the ladder FIX uses');
  assert.match(body, /fixPostCitation\(\{/, 'rung 2: the post’s statements one at a time');
  assert.match(body, /rewriteClaimToStudy\(/, 'rung 3: only the overclaiming sentences, to the best real study');
  assert.match(body, /fixCitation\(db, run, pack, aviso, \[help\.item\]\)/, 'and the rewrite is judged and stamped again');
});

test('Fix citation keeps time for the correction, runs a strict second pass, and says what it did', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const autopilot = src('lib/autopilot.ts');
  const body = autopilot.slice(autopilot.indexOf('export async function fixCitationOnly('), autopilot.indexOf('/** Write the step FIX is on'));
  // The research can never eat the rewrite.
  assert.match(autopilot, /const CITATION_REWRITE_RESERVE_MS = 150_000;/);
  assert.match(body, /const researchMs = left\(\) - CITATION_REWRITE_RESERVE_MS;/);
  assert.match(body, /fixPostCitation\(\{ text: caption, pack: p, aviso, budgetMs: Math\.min\(120_000, researchMs\) \}\)/);
  // Every channel at once, then a stricter pass if the checker still disagrees.
  assert.match(body, /for \(const strict of \[false, true\]\)/);
  assert.match(body, /await Promise\.all\(keys\.map\(\(k\) => rewriteClaimToStudy\(String\(p\[k\]\), study, timeout, \{ strict \}\)\)\)/);
  // Not fixed: the card says what was searched and corrected, not one bare line.
  assert.match(body, /' \(what it did: ' \+ changes\.join\('; '\) \+ '\)'/);
});

test('the strict pass turns every unbacked health statement into what the study reports, or into advice that claims nothing', () => {
  assert.match(CLAIM_REWRITE_STRICT_SYSTEM, /^You edit social posts/, 'the base rules still apply');
  assert.match(CLAIM_REWRITE_STRICT_SYSTEM, /turn the sentence into practical general advice that claims no benefit at all/);
  assert.match(CLAIM_REWRITE_STRICT_SYSTEM, /"proven", "improves", "boosts"/);
});

test('relevance: the study must be about what the post talks about', () => {
  assert.equal(parseRelevance('{"onTopic": true}'), true);
  assert.equal(parseRelevance('```json\n{"onTopic": false}\n```'), false);
  assert.equal(parseRelevance('yes'), true);
  assert.equal(parseRelevance('No.'), false);
  assert.equal(parseRelevance('maybe'), null, 'an unclear answer is not a yes');
  const p = relevancePrompt('Keep a journal of how you feel.', { title: 'Coding Telemedicine Visits for Proper Reimbursement', abstract: 'Billing codes.', ref: 'REF: x' });
  assert.match(p, /THE POST\nKeep a journal/);
  assert.match(p, /Title: Coding Telemedicine Visits/);
});

test('no study on the subject: the rewrite must drop the REF line, keep the AVISO and claim nothing', () => {
  const before = 'Track your recovery and pain each day.\n\nREF: Gross 2020 doi:10.1007/s11882-020-00970-0\n\nAVISO DE PUBLICIDAD 123';
  const good = 'Write down how you feel each day and bring it to your follow-up visit.\n\nAVISO DE PUBLICIDAD 123';
  assert.deepEqual(acceptNoClaim(before, good), { text: good, flagged: [] });
  assert.equal(acceptNoClaim(before, good + '\nREF: Gross 2020').text, null, 'the citation must go');
  assert.equal(acceptNoClaim(before, 'Write down how you feel each day and bring it along.').text, null, 'the AVISO must stay');
  const still = acceptNoClaim(before, 'Write down your recovery and any pain each day and bring it along.\n\nAVISO DE PUBLICIDAD 123');
  assert.equal(still.text, null);
  assert.deepEqual(still.flagged.map((w) => w.toLowerCase()).sort(), ['pain', 'recovery'], 'and it says which words still read as a claim');
  assert.match(noClaimPrompt('x', ['pain', 'recovery']), /replace every one: pain, recovery/);
  assert.match(NO_CLAIM_SYSTEM, /Delete the REF \/ REFERENCIA line entirely\. Keep the AVISO DE PUBLICIDAD line exactly as it is\./);
  assert.deepEqual(healthClaimWords('Pain and pain relief, then recovery.').map((w) => w.toLowerCase()), ['pain', 'relief', 'recovery']);
});

test('Fix citation never rewrites a post around a study on another subject, and drops the citation when none exists', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const autopilot = src('lib/autopilot.ts');
  const body = autopilot.slice(autopilot.indexOf('export async function fixCitationOnly('), autopilot.indexOf('/** Write the step FIX is on'));
  // Asked before any rewrite toward it; an unclear answer counts as no.
  assert.match(body, /onTopic = \(await studyOnTopic\(caption0, \{[^}]*\}\)\) === true;/);
  assert.match(body, /if \(help && onTopic\) \{/);
  // Rung 4: only where the template allows a post with no claim to carry no citation.
  assert.match(body, /const canDropRef = refPolicyOf\(pack\) === 'if-health-claim';/);
  assert.match(body, /rewriteWithoutClaims\(String\(p\[k\]\), \[\], timeout\(\)\)/);
  assert.match(body, /rewriteWithoutClaims\(String\(p\[k\]\), results\[i\]\.flagged, timeout\(\)\)/, 'a second try, told which words');
  assert.match(body, /if \(keys\.length && results\.every\(\(r\) => r\.text\)\)/, 'every channel or nothing');
  assert.match(body, /citation: \{ status: 'not_required', doi: null, title: null, year: null \}/);
  assert.match(body, /_claimSupport: undefined, claimSupport: undefined/);
  assert.match(body, /read it before approving/);
  // A template that requires a citation is told so, not given an unrelated one.
  assert.match(body, /this template requires a citation — edit the claim or add a source/);
  // The note says what it did when it fixed it, too.
  assert.match(body, /fixedIt && changes\.length \? ' What it did: ' \+ changes\.join\('; '\) \+ '\.' : ''/);
});

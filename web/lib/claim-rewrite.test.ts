import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAIM_REWRITE_SYSTEM, acceptRewrite, claimRewritePrompt } from './claim-rewrite.ts';

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

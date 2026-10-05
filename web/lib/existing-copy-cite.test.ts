import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATUS_TEXT } from './video-row.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('copy a person wrote is queued with the AVISO line and a researched REF line — the words untouched, the COPY cell never written', () => {
  const cite = src('lib/existing-copy-cite.ts');
  assert.match(cite, /const withAviso = ensureAviso\(String\(opts\.text \|\| ''\)\.trim\(\), aviso\);/, 'the AVISO first');
  assert.match(cite, /if \(check\.ref && check\.doi\) \{[\s\S]{0,200}outcome: 'kept'/, 'a REF the person wrote is kept');
  assert.match(cite, /if \(!makesHealthClaim\(withAviso\)\)[\s\S]{0,200}outcome: 'not_needed'/, 'no claim, no citation needed');
  assert.match(cite, /fixPostCitation\(\{\s*text: withAviso,\s*pack: \{ title: String\(opts\.title \|\| ''\)\.trim\(\), kind: 'video' \}/, 'the same ladder Verify / fix climbs, searching the video’s title too');
  assert.match(cite, /status: fix\.status === 'unchecked' \? 'unchecked' : 'unsupported'/, 'nothing found: stamped so the doors hold it');

  const auto = src('lib/video-autopilot.ts');
  const queue = auto.slice(auto.indexOf('async function queueExistingCopyRow('), auto.indexOf('export type QueueExistingResult'));
  assert.match(queue, /const cited = await citeExistingCopy\(\{ userId: a\.userId, text: existingCopyText\(a\.copy\), title: a\.title/, 'before the draft and the hand-off');
  assert.match(queue, /const text = cited\.text;/);
  assert.match(queue, /\.\.\.\(cited\.claimSupport \? \{ claimSupport: cited\.claimSupport \} : \{\}\)/, 'the verdict rides on the draft');
  assert.match(queue, /\.\.\.\(cited\.outcome === 'cited' && cited\.ref \? \{ ref: cited\.ref \} : \{\}\),/, 'the REF column, when found');
  assert.doesNotMatch(queue, /\bcopy: /, 'the COPY cell is never named');
  assert.match(queue, /return \{ draftId, metricool: posted, citation \};/);
  // The sweep gives it what is left of its own time, so the research never outlives the request.
  assert.match(auto, /actor: 'sweep', skipMetricool: opts\.skipMetricool,\s*budgetMs: Math\.max\(20_000, budgetMs - \(Date\.now\(\) - started\)\),/);
  assert.equal(STATUS_TEXT.queued_existing_cited, 'En cola — copy existente + REF encontrada');
  assert.equal(STATUS_TEXT.queued_existing_needs_ref, 'En cola — copy existente, SIN REF (revisar)');
});

test('the panel and the composer say what became of the citation, and the composer can go and find one', () => {
  const route = src('app/api/videos/queue/route.ts');
  assert.match(route, /citation: out\.citation/);
  const view = src('components/SourcesView.tsx');
  assert.match(view, /REF found and added: /);
  assert.match(view, /no study found to cite — the doors hold it until a REF line is added/);
  assert.match(view, /queued as written, with the AVISO line and a researched REF line added when the copy needs one/);
  // The composer: the send door's REF refusal now carries the button that fixes it.
  const cite = src('app/api/posts/cite/route.ts');
  assert.match(cite, /const auth = await requireAllowlistedUser\(\);/);
  assert.match(cite, /checkRateLimit\(auth\.userId, 'video-prepare'\)/);
  assert.match(cite, /citeExistingCopy\(\{ userId: auth\.userId, text, title, budgetMs: 90_000 \}\)/);
  const page = src('app/page.tsx');
  assert.match(page, /mCompliance\.missing\.includes\('ref'\) \|\| mCompliance\.missing\.includes\('doi'\)\) && \(\s*<button type="button" onClick=\{\(\) => void citeComposerCopy\(\)\}/);
  assert.match(page, /fetch\('\/api\/posts\/cite', \{ method: 'POST'/);
  assert.match(page, /if \(typeof j\?\.text === 'string' && j\.text\.trim\(\)\) setMText\(j\.text\);/, 'the cited copy replaces the box');
});

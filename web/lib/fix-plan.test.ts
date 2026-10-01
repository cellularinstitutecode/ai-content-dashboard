// web/lib/fix-plan.test.ts
// The FIX button: which repairs a card needs, from the same stamps its
// warnings are drawn from — and where the button is actually wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIX_STALE_MS, FIX_STALLED_NOTE, fixImageMode, fixNote, fixPlan, fixRedraftNote, fixRunning, fixStale, fixStepsLabel, fixView, imageFlagged, needsFix, runFixInput, splitFixPlan, swapRefLine } from './fix-plan.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a card with no warnings needs no fix', () => {
  assert.deepEqual(fixPlan(null), { steps: [], reasons: [] });
  assert.equal(needsFix(runFixInput({
    score: { safetyFlags: [], promotionFlags: [], openingRepeat: false },
    pack: { _compliance: { citation: { status: 'verified' } }, _claimSupport: { status: 'supported' }, _image: { url: 'x', verification: { status: 'approved' } } },
  })), false);
  // A post that needs no citation, and an older pack with no stamps at all.
  assert.equal(needsFix({ citation: { status: 'not_required' } }), false);
  assert.equal(needsFix(runFixInput({ score: null, pack: null })), false);
});

test('every citation warning the card shows is a citation step', () => {
  for (const status of ['not_found', 'mismatch', 'no_doi', 'unavailable']) {
    assert.deepEqual(fixPlan({ citation: { status } }).steps, ['citation'], status);
  }
  assert.deepEqual(fixPlan({ claimSupport: { status: 'unsupported' } }).steps, ['citation']);
  assert.deepEqual(fixPlan({ claimSupport: { status: 'unchecked' } }).steps, ['citation']);
  assert.deepEqual(fixPlan({ claimSupport: { status: 'swapped' } }).steps, []);
  const both = fixPlan({ citation: { status: 'not_found' }, claimSupport: { status: 'unsupported' } });
  assert.deepEqual(both.steps, ['citation'], 'one step, two reasons');
  assert.equal(both.reasons.length, 2);
});

test('compliance, promotion and opening flags are a copy step; a flagged picture an image step', () => {
  assert.deepEqual(fixPlan({ safetyFlags: [{ code: 'advice', message: 'Diagnostic/treatment-advice phrasing' }] }).steps, ['copy']);
  assert.deepEqual(fixPlan({ promotionFlags: ['booking close'] }).steps, ['copy']);
  assert.deepEqual(fixPlan({ openingRepeat: true }).steps, ['copy']);
  assert.deepEqual(fixPlan({ image: { url: 'x', verification: { status: 'flagged', issues: ['off-topic — the picture does not show what this post is about'] } } }).steps, ['image']);
  assert.deepEqual(fixPlan({ image: { url: 'x', verification: { status: 'approved', textDetected: true } } }).steps, ['image'], 'text can never pass');
  assert.deepEqual(fixPlan({ image: { url: 'x', verification: { status: 'approved', issues: ['banned prop in frame'] } } }).steps, ['image']);
  // A clinic photo is theirs; "review manually" (unchecked) is not a warning.
  assert.equal(imageFlagged({ url: 'x', source: 'library', verification: { status: 'flagged' } }), false);
  assert.equal(imageFlagged({ url: 'x', source: 'upload', verification: { status: 'flagged', textDetected: true } }), false);
  assert.equal(imageFlagged({ url: 'x', verification: { status: 'unchecked' } }), false);
  assert.equal(imageFlagged({ url: '', verification: { status: 'flagged' } }), false);
});

test('a flagged picture: an AI take is regenerated; a brand-graded library photo is replaced by one, and the plan says so', () => {
  // An older "styled after a library photo" take IS an AI image (no source).
  const styled = { url: 'x', styledAfter: 'https://lib/photo.jpg', verification: { status: 'flagged', issues: ['off-topic — the picture does not show what this post is about'] } };
  assert.equal(imageFlagged(styled), true);
  assert.equal(fixImageMode(styled), 'ai');
  // A library photo that went through the brand filter was checked like a cover.
  const graded = { url: 'x', source: 'library', brandGraded: true, verification: { status: 'flagged', issues: ['a head reaches into the title area (top of head at 12% from the top)'] } };
  assert.equal(imageFlagged(graded), true);
  assert.equal(fixImageMode(graded), 'library-to-ai');
  const plan = fixPlan({ image: graded });
  assert.deepEqual(plan.steps, ['image']);
  assert.match(plan.reasons[0], /FIX makes an AI image in its place; pick another library photo/);
  assert.match(plan.reasons[0], /head reaches into the title area/, 'the checker\'s own words');
  // Clean, or chosen as it is: nothing to do.
  assert.equal(fixImageMode({ url: 'x', source: 'library', brandGraded: true, verification: { status: 'approved' } }), null);
  assert.equal(fixImageMode({ url: 'x', source: 'library', verification: { status: 'flagged' } }), null);
});

test('the steps come in the order the repair runs, whatever order the flags came in', () => {
  const plan = fixPlan({
    image: { url: 'x', verification: { status: 'flagged' } },
    openingRepeat: true,
    citation: { status: 'mismatch' },
  });
  assert.deepEqual(plan.steps, ['citation', 'copy', 'image']);
  assert.equal(fixStepsLabel(plan.steps), 'citation, copy and image');
  assert.equal(fixStepsLabel(['image']), 'image');
  assert.equal(fixStepsLabel([]), '');
});

test('the redraft note quotes each flag and names the study to write to', () => {
  const note = fixRedraftNote(
    { safetyFlags: [{ code: 'advice', message: 'Diagnostic/treatment-advice phrasing' }], promotionFlags: ['booking close'], openingRepeat: true },
    { title: 'Red light and recovery', year: 2021, abstract: 'We measured recovery after exercise.', ref: 'REF: Smith et al. (2021). Red light and recovery. J. DOI: 10.1/x' },
  );
  assert.match(note, /^Keep the post as it is except/);
  assert.match(note, /"Diagnostic\/treatment-advice phrasing"/);
  assert.match(note, /remove: booking close/);
  assert.match(note, /different first sentence/);
  assert.match(note, /Rewrite ONLY the sentence\(s\)/);
  assert.match(note, /"Red light and recovery" \(2021\) — We measured recovery/);
  assert.match(note, /Cite exactly this study: REF: Smith/);
  // No claim help: nothing about a study.
  assert.doesNotMatch(fixRedraftNote({ openingRepeat: true }), /study/);
});

test('the note on the card says what was fixed and what still needs a look', () => {
  assert.equal(fixNote({ fixed: ['citation', 'image'], remaining: [] }), 'Fixed: citation, image. Everything was re-checked.');
  assert.equal(fixNote({ fixed: ['citation'], remaining: ['the image — the new picture was flagged too'] }), 'Fixed: citation. Still needs a look: the image — the new picture was flagged too.');
  assert.equal(fixNote({ fixed: [], remaining: ['the copy — its time has passed'] }), 'Nothing needed fixing. Still needs a look: the copy — its time has passed.');
});

test('swapRefLine replaces the REF line in place and keeps the rest of the copy', () => {
  const caption = 'Body of the post.\n\n#stemcells #cancun\n\nREF: Old et al. (2019). Made up. DOI: 10.1000/fake\n\nAVISO DE PUBLICIDAD: 2623022002A00090';
  const out = swapRefLine(caption, 'REF: New et al. (2024). Real paper. Journal. DOI: 10.1000/real');
  assert.equal(out, 'Body of the post.\n\n#stemcells #cancun\n\nREF: New et al. (2024). Real paper. Journal. DOI: 10.1000/real\n\nAVISO DE PUBLICIDAD: 2623022002A00090');
  // The label is normalised, and a second REF line goes.
  const two = swapRefLine('Text\nREF: one\nREFERENCIA: two\n', 'New et al. DOI: 10.1/x');
  assert.equal(two, 'Text\nREF: New et al. DOI: 10.1/x\n\n');
  // No REF line: before the AVISO, or at the end.
  assert.equal(swapRefLine('Text\n\nAVISO DE PUBLICIDAD: 1', 'REF: r'), 'Text\n\nREF: r\nAVISO DE PUBLICIDAD: 1');
  assert.equal(swapRefLine('Text\n', 'r'), 'Text\n\nREF: r');
  // An article keeps its paragraphs.
  const blog = '# Title\n\nParagraph one.\n\nParagraph two.\n\nREF: Old. DOI: 10.1/old\n\nAVISO DE PUBLICIDAD: 1';
  assert.equal(swapRefLine(blog, 'New. DOI: 10.1/new'), '# Title\n\nParagraph one.\n\nParagraph two.\n\nREF: New. DOI: 10.1/new\n\nAVISO DE PUBLICIDAD: 1');
  assert.equal(swapRefLine('Text\nREF: keep', ''), 'Text\nREF: keep', 'an empty line changes nothing');
});

// --- WHERE IT IS WIRED -------------------------------------------------------

test('the route starts FIX and answers at once; the work runs after the response', () => {
  const route = src('app/api/autopilot/runs/route.ts');
  assert.match(route, /if \(action === 'run_now' \|\| action === 'regenerate' \|\| action === 'fix'\) \{\s*const rl = await checkRateLimit\(user\.id, 'autopilot-action'\)/, 'the same rate-limit bucket');
  // Held open, the request kept a loader over the card at 94% for minutes.
  // Two scopes: "Fix citation" (the citation only) and FIX (the copy and the picture).
  assert.match(route, /const scope: 'citation' \| 'general' = body\.scope === 'citation' \? 'citation' : 'general';/);
  assert.match(route, /if \(action === 'fix'\) \{[\s\S]{0,1200}?const started = await startFix\(id, user\.id, scope === 'citation' \? \['citation'\] : \['copy', 'image'\]\);[\s\S]{0,300}?after\(\(\) => fixRunInBackground\(id, user\.id, scope\)\);/);
  assert.match(route, /\{ status: 202 \}/);
  assert.doesNotMatch(route, /await fixRun\(/, 'the request never waits on the repair');
  assert.match(route, /import \{ NextRequest, NextResponse, after \} from 'next\/server';/);
  assert.match(route, /export const maxDuration = 300;/, 'the background work runs inside this budget');

  const autopilot = src('lib/autopilot.ts');
  const start = autopilot.slice(autopilot.indexOf('export async function startFix('), autopilot.indexOf('export async function fixRunInBackground('));
  assert.match(start, /if \(fixRunning\(run\.angle\)\) return/, 'a second press waits for the first');
  assert.match(start, /\.eq\('state', 'ready_for_review'\)/);
  const bg = autopilot.slice(autopilot.indexOf('export async function fixRunInBackground('));
  // The result is written whatever happens, so the card never waits forever.
  assert.match(bg, /try \{\s*result = scope === 'citation' \? await fixCitationOnly\(runId, userId\) : await fixRun\(runId, userId, \{ only: \['copy', 'image'\] \}\);\s*\} catch/);
  assert.match(bg, /state: result\.ok \? 'done' : 'failed'/);
});

test('fixRun reuses the existing pipelines rather than its own', () => {
  const autopilot = src('lib/autopilot.ts');
  const body = autopilot.slice(autopilot.indexOf('export async function fixRun('));
  assert.match(body, /await regenerateRun\(run\.id, userId, note, \{ noteLimit: 1400 \}\)/, 'the copy goes through "Ask for changes"');
  assert.match(body, /await advanceRuns\(\{ scopeUserId: userId, runId: run\.id/, 'and is redrafted right away');
  assert.match(body, /await ensureDraftImage\(draftId, userId, \{ force: true, budgetMs: left\(\) - 20_000 \}\)/, 'the picture through the verified path, inside what is left of the budget');
  assert.match(body, /const imageMode = want\('image'\) \? fixImageMode\(image\) : null;\s*if \(imageMode\)/, 'and only when it is flagged, and in scope');
  // FIX on the card no longer touches the citation: that is "Fix citation"'s job.
  assert.match(body, /if \(want\('citation'\) && fixPlan\(input\)\.steps\.includes\('citation'\)\) \{ await onStep\('citation'\); await citationPass\(\); \}/);
  assert.match(body, /const initial = \{ \.\.\.planned, steps: planned\.steps\.filter\(want\) \};/);
  assert.match(body, /the flagged library photo was replaced by an AI image/, 'a graded library photo is replaced, and the note says so');
  // The step in progress is stamped on the run as each one starts.
  assert.match(body, /await onStep\('citation'\)/);
  assert.match(body, /await onStep\('copy'\)/);
  assert.match(body, /await onStep\('image'\)/);
  assert.match(autopilot, /async function markFixStep\(/);
  // The generation loop honours the budget it was handed.
  const images = src('lib/images.ts');
  assert.match(images, /if \(attempt > 0 && !fits\(\)\) break;/, 'no retry that cannot finish in time');
  assert.match(images, /budgetMs: opts\.budgetMs \?\? null,/, 'ensureDraftImage passes it through');
  assert.match(body, /logLine\(run, 'fix'/, 'the run says what FIX changed');
  assert.match(body, /for \(let attempt = 0; attempt < FIX_REDRAFT_ATTEMPTS; attempt\+\+\)/);
  assert.match(autopilot, /const FIX_REDRAFT_ATTEMPTS = 2;/, 'up to two redrafts');
  const ladder = autopilot.slice(autopilot.indexOf('async function fixCitation('), autopilot.indexOf('export async function fixRun('));
  assert.match(ladder, /judgeClaimSupport\(\{ claim, items: candidates \}\)/, 'rung 1: the papers in hand');
  assert.match(ladder, /claimQuery\(claim\)/, 'rung 2: search at the claim');
  assert.match(ladder, /refLineFrom\(item\)/, 'the drafter\'s own REF format');
  assert.match(ladder, /verifyDoi\(item\.doi, \{ expectedTitle: item\.title \}\)/, 'verified with the title match');
  assert.match(ladder, /swapRefLine\(text, line\)/, 'on every channel');
  assert.match(ladder, /if \(checked\.status === 'not_found' \|\| checked\.status === 'mismatch'\) return null;/, 'never a REF Crossref rejects');
});

test('both review cards and the calendar row show FIX from the same plan', () => {
  const queue = src('app/AutopilotQueue.tsx');
  assert.match(queue, /fixPlan\(runFixInput\(r\)\)/);
  assert.match(queue, /act\(r\.id, 'fix'\)/);
  assert.match(queue, /act\(r\.id, 'fix', undefined, false, false, 'citation'\)/, 'Fix citation, its own button');
  assert.match(queue, /const \{ general, citation \} = splitFixPlan\(plan\);/);
  assert.match(queue, />\s*Fix citation\s*</);
  assert.match(queue, /<FixStatusLine angle=\{r\.angle\}/, 'progress and result from the run');
  assert.match(queue, /if \(!fixingIds\) return;\s*const t = window\.setInterval/, 'polled while it runs');
  assert.match(queue, /'run_now' \| 'regenerate' \| 'fix'/);

  const preview = src('components/RunPreview.tsx');
  assert.match(preview, /fixPlan\(runFixInput\(run\)\)/);
  assert.match(preview, /onClick=\{onFix\}/);
  assert.match(preview, /\{fixing \? 'Fixing…' : 'FIX ' \+ fixStepsLabel\(general\.steps\)\}/);
  assert.match(preview, /onClick=\{\(\) => \(onFixCitation \|\| onFix\)\(\)\}/);
  assert.match(preview, /\{fixing \? 'Fixing…' : 'Fix citation'\}/);
  assert.match(preview, /const fixing = fixRunning\(run\.angle\);/);
  assert.match(preview, /<FixStatusLine angle=\{run\.angle\}/);
  // The preview is never covered while FIX works: it can be read and closed.
  assert.doesNotMatch(preview, /PanelLoader/);

  const page = src('app/calendar/page.tsx');
  assert.match(page, /'approve' \| 'skip' \| 'fix'/);
  assert.match(page, /splitFixPlan\(fixPlan\(runFixInput\(r\)\)\)/, 'the list row too');
  assert.match(page, /onFixCitation=\{\(\) => fixRunCitation\(previewRun\)\}/);
  assert.match(page, /void runAct\(run, 'fix', false, 'citation'\);/);
  assert.match(page, /onFix=\{\(\) => fixRun\(previewRun\)\}/);
  assert.match(page, /if \(!fixingIds\) return;\s*const t = window\.setInterval/, 'polled while it runs');
  assert.doesNotMatch(page, /x-chi-progress-scope': 'calendar-run:/, 'no loader over the preview');
});

test('FIX in the background: running, done, and a run that never finished', () => {
  const t0 = Date.parse('2026-09-29T08:00:00Z');
  const startedAt = new Date(t0).toISOString();
  const running = { fix: { state: 'running' as const, startedAt } };
  assert.deepEqual(fixView(running, t0 + 45_000), { kind: 'running', elapsedSec: 45, startedAt, step: null });
  assert.deepEqual(fixView({ fix: { state: 'running' as const, startedAt, step: 'image' as const } }, t0 + 45_000), { kind: 'running', elapsedSec: 45, startedAt, step: 'image' });
  assert.equal(fixRunning(running, t0 + 45_000), true);
  // The platform cut it off: it must not read as running forever. Ten minutes
  // — a live FIX has a budget a little over four and must never be called stuck.
  assert.equal(FIX_STALE_MS, 10 * 60_000);
  assert.equal(fixStale(running.fix, t0 + 4.5 * 60_000), false);
  assert.deepEqual(fixView(running, t0 + FIX_STALE_MS + 1), { kind: 'stalled' });
  assert.equal(fixStale(running.fix, t0 + FIX_STALE_MS + 1), true);
  assert.equal(fixStale({ state: 'done', startedAt }), false);
  assert.equal(fixRunning(running, t0 + FIX_STALE_MS + 1), false);
  assert.match(FIX_STALLED_NOTE, /^FIX did not finish — press it again/);
  // The tick closes such a stamp on the run itself, so every screen and the log agree.
  const autopilot = src('lib/autopilot.ts');
  const sweep = autopilot.slice(autopilot.indexOf('export async function expireStaleFixes('), autopilot.indexOf('export async function startFix('));
  assert.match(sweep, /if \(!fixStale\(fix\)\) continue;/);
  assert.match(sweep, /state: 'failed'/);
  assert.match(sweep, /note: FIX_STALLED_NOTE/);
  assert.match(src('app/api/autopilot/tick/route.ts'), /const staleFixes = await expireStaleFixes\(scopeUserId\);/);
  const line = src('components/FixStatusLine.tsx');
  assert.match(line, /\{FIX_STALLED_NOTE\}/, 'the card uses the same words');
  assert.match(line, /started ' \+ started/, 'and says when it started');
  assert.match(line, /now: the ' \+ view\.step/, 'and what it is on');
  // The panel banner never keeps saying "working on it" after the run moved on.
  const queue = src('app/AutopilotQueue.tsx');
  assert.match(queue, /if \(j\?\.note && action !== 'fix'\) setNote/);
  assert.match(queue, /setNote\(\(n\) => \(n && \/\^FIX is working\/\.test\(n\) \? null : n\)\);/);
  assert.deepEqual(
    fixView({ fix: { state: 'done', startedAt: '', note: 'Fixed: citation.', remaining: [] } }),
    { kind: 'done', note: 'Fixed: citation.', clean: true },
  );
  assert.deepEqual(
    fixView({ fix: { state: 'done', startedAt: '', note: 'Fixed: copy. Still needs a look: the image.', remaining: ['the image'] } }),
    { kind: 'done', note: 'Fixed: copy. Still needs a look: the image.', clean: false },
  );
  assert.equal(fixView(null), null);
  assert.equal(fixView({}), null);
});

test('splitFixPlan: the citation on its own button, the copy and the picture on FIX', () => {
  const plan = fixPlan({
    claimSupport: { status: 'unsupported' },
    safetyFlags: [{ code: 'x', message: 'cure claim' }],
    image: { url: 'u', source: 'ai', verification: { status: 'flagged', textDetected: true } },
  });
  assert.deepEqual(plan.steps, ['citation', 'copy', 'image']);
  const { general, citation } = splitFixPlan(plan);
  assert.deepEqual(citation.steps, ['citation']);
  assert.deepEqual(general.steps, ['copy', 'image']);
  assert.ok(citation.reasons.some((r) => /does not clearly support/.test(r)));
  assert.ok(!general.reasons.some((r) => /does not clearly support/.test(r)));
  assert.ok(general.reasons.some((r) => /text in the image/.test(r)));
  const onlyCitation = splitFixPlan(fixPlan({ claimSupport: { status: 'unsupported' } }));
  assert.deepEqual(onlyCitation.general.steps, [], 'a citation warning alone shows Fix citation and no FIX');
});

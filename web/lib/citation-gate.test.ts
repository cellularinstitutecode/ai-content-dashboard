// web/lib/citation-gate.test.ts
// The September audit's three findings, as tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_DISTINCT_WORDS, claimSupportOf, claimSupportRefusal, looksLikeSpeech, writerRefusedContent } from './citation-gate.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the judge saying no is the one status that refuses a send', () => {
  assert.match(String(claimSupportRefusal('unsupported')), /does not support what this post says/);
  assert.match(String(claimSupportRefusal('unsupported')), /Nothing was sent/);
  // The judge not having run is not evidence of a problem: the DOI is already verified.
  assert.equal(claimSupportRefusal('unchecked'), null);
  assert.equal(claimSupportRefusal('supported'), null);
  assert.equal(claimSupportRefusal('swapped'), null);
  assert.equal(claimSupportRefusal(null), null);
  assert.equal(claimSupportRefusal(''), null);
});

test('the stamp is read off the pack, however it was cased', () => {
  assert.equal(claimSupportOf({ _claimSupport: { status: 'Unsupported', doi: '10.1/x' } }), 'unsupported');
  assert.equal(claimSupportOf({ _claimSupport: null }), null);
  // The video pipeline's spelling, which the gate used to miss entirely.
  assert.equal(claimSupportOf({ kind: 'video', claimSupport: { status: 'unsupported', doi: '10.1/x' } }), 'unsupported');
  assert.equal(claimSupportOf({ _claimSupport: { status: 'supported' }, claimSupport: { status: 'unsupported' } }), 'supported');
  assert.equal(claimSupportOf({}), null);
  assert.equal(claimSupportOf(null), null);
  assert.equal(claimSupportOf('text'), null);
});

test('the writer describing an empty transcript is caught, a real caption is not', () => {
  // The draft the audit found, in effect.
  assert.equal(writerRefusedContent('The transcript provided does not contain any content to base a post on. AVISO: ... REF: Smith 2020'), true);
  assert.equal(writerRefusedContent('Unfortunately the transcription is empty, so I cannot write the caption.'), true);
  assert.equal(writerRefusedContent("I'm sorry, but I am unable to create a post without the video's content."), true);
  assert.equal(writerRefusedContent('The video does not contain any speech.'), true);
  assert.equal(writerRefusedContent('Please provide the transcript so I can write the post.'), true);
  // Clinic copy that happens to be about something not working.
  assert.equal(writerRefusedContent('Hyperbaric oxygen does not replace surgery, but it can shorten recovery after it. Ask us how.\n\nREF: Smith 2020'), false);
  assert.equal(writerRefusedContent('In this video our team walks through the peptide protocol step by step.'), false);
  assert.equal(writerRefusedContent(''), false);
  assert.equal(writerRefusedContent(null), false);
});

test('sound tags and a looping "thank you" are not speech; a few real sentences are', () => {
  assert.equal(looksLikeSpeech('[Music] [Music] Thank you. [Applause] Thank you. [Music] Thank you very much.'), false);
  assert.equal(looksLikeSpeech('♪ ♪ ♪ (upbeat music) (laughs)'), false);
  assert.equal(looksLikeSpeech(''), false);
  assert.equal(looksLikeSpeech(
    'Today we are looking at how hyperbaric oxygen changes tissue oxygenation before a stem cell treatment, and why the timing matters for recovery.',
  ), true);
  assert.equal(looksLikeSpeech(
    'Hoy hablamos de cómo el oxígeno hiperbárico mejora la oxigenación del tejido antes del tratamiento con células madre y por qué importa el tiempo.',
  ), true);
  assert.ok(MIN_DISTINCT_WORDS >= 10);
});

test('every door a person sends through reads the judge\'s verdict', () => {
  // The audit's finding: the verdict existed and nothing at the doors read it.
  const gate = src('lib/compliance-gate.ts');
  assert.match(gate, /claimSupportRefusal\(opts\.claimSupport\)/);
  for (const p of ['app/api/posts/route.ts', 'app/api/metricool/schedule/route.ts', 'lib/video-publish.ts']) {
    const s = src(p);
    assert.match(s, /claimSupportOf\(/, p + ' does not read the stamp');
    assert.match(s, /claimSupport: /, p + ' does not hand the stamp to the gate');
  }
  // Autopilot's approve judges the citation as it stands and refuses on 'unsupported'.
  const autopilot = src('lib/autopilot.ts');
  const door = autopilot.slice(autopilot.indexOf('DOES THE STUDY BACK WHAT THE POST SAYS?'), autopilot.indexOf('// And the video rule, at the same door'));
  assert.match(door, /findByDoi\(cited\)/);
  assert.match(door, /judgeClaimSupport\(/);
  // A person's Approve writes the verdict down as a remark and goes ahead;
  // the engine's own auto-schedule (no remarkCitation) still refuses.
  assert.match(door, /const unsupported = claimSupportRefusal\(status\);\s*if \(unsupported\) \{\s*if \(opts\.remarkCitation\) remarks\.push\(/);
  assert.match(door, /else \{\s*await releaseClaim\(db, run, 'approve-refused', unsupported\)/);
});

test('the video path never cites a search hit the judge has already rejected', () => {
  const prepare = src('lib/video-prepare.ts');
  // The top-hit fallback is gone altogether: a citation ships from the video
  // writer only when the judge confirmed it backs the copy. On 7 October a
  // reel about single-ingredient foods went out under a tea-quality review
  // because the judge had not been asked and the writer's pick shipped as is.
  assert.doesNotMatch(prepare, /refLineFromEvidence\(evidence\)/, 'no search hit is ever cited unjudged');
  assert.match(prepare, /const unsupported = !backing;/, 'not backed by the judge is not backed');
  assert.match(prepare, /if \(unsupported\) \{\s*claimSupport = \{ status: 'unsupported'/);
  // ...and when two drafts both claimed what no paper shows, takes the claims
  // out (rung 4, the clinic's rule: no health claim, no citation needed) and
  // refuses, in words, only when they cannot come out.
  assert.match(prepare, /defect\.kind === 'unsupported_citation'[\s\S]{0,1200}await dropClaims\([\s\S]{0,2600}error: 'unsupported_citation'/);
  // ...and a writer that wrote about the empty transcript is a refusal that asks for the words.
  assert.match(prepare, /writerRefusedContent\(tiktok\) \|\| writerRefusedContent\(linkedin\)[\s\S]{0,600}error: 'empty_transcript'[\s\S]{0,400}needsPaste: true/);
  // ...and neither refusal is retried by the sweep.
  const kinds = src('lib/failure-kind.ts');
  assert.match(kinds, /'unsupported_citation',/);
  assert.match(kinds, /'empty_transcript',/);
});

test('a transcript is judged by its speech, not its length', () => {
  const transcript = src('lib/video-transcript.ts');
  assert.match(transcript, /pasted\.length < MIN_CHARS \|\| !looksLikeSpeech\(pasted\)/);
  assert.match(transcript, /text\.length < MIN_CHARS \|\| !looksLikeSpeech\(text\)/);
});

test('off-subject search hits are dropped before the writer sees them', () => {
  const evidence = src('lib/evidence.ts');
  assert.match(evidence, /filterRelevant\(await fromPubmed\(/);
  assert.match(evidence, /filterRelevant\(await fromCrossref\(/);
});

test('"Verify / fix" on a calendar post runs the ladder and carries the result to Metricool', () => {
  const page = src('app/calendar/page.tsx');
  // The button sits to the left of "Show on calendar", and nothing else moved.
  assert.match(page, /Verify \/ fix'\}<\/button>\s*<button[\s\S]{0,400}?>Show on calendar<\/button>/);
  assert.match(page, /action: 'fix_citation'/);
  const route = src('app/api/posts/route.ts');
  assert.match(route, /'fix_citation'\]\.includes\(action\)/, 'the route accepts the action');
  assert.match(route, /fixPostCitation\(\{ text: String\(existing\.text \|\| ''\), pack: draftPack/);
  // A swapped citation reaches the post row, the draft, and Metricool's copy.
  assert.match(route, /from\('posts'\)\.update\(\{ text: fix\.text \}\)/);
  assert.match(route, /\(existing as \{ text\?: string \| null \}\)\.text = fix\.text;/);
  // ...and never approves: the action leaves `mode` and `nextStatus` alone.
  const branch = route.slice(route.indexOf("} else if (action === 'fix_citation') {"), route.indexOf("} else if (action === 'attach_video') {"));
  assert.doesNotMatch(branch, /mode = 'scheduled'|nextStatus =/);
  const fix = src('lib/post-citation-fix.ts');
  // Verified before swapped, never redrafted, and 'unsupported' when nothing backs the copy.
  assert.match(fix, /verifyDoi\(backing\.doi, \{ expectedTitle: backing\.title \}\)/);
  assert.doesNotMatch(fix, /generateContentPack|generateVideoCopy|from '@\/lib\/video-copy'/, 'the words stay the clinic\'s; only the citation is ours');
  assert.match(fix, /stampOn\('unsupported'/);
});

test('a citation Metricool did not take is still a fix, and a post Metricool lost is sent again', () => {
  const route = src('app/api/posts/route.ts');
  const block = route.slice(route.indexOf("if (action === 'fix_citation') {\n        // The citation IS saved"), route.indexOf("if (!resent) {"));
  // Never a 502 for a change that was saved: the preview must reload the new REF line.
  assert.doesNotMatch(block, /status: 502/);
  assert.match(block, /fixed: true, status: 'swapped'/);
  // A 404 with the slot ahead is re-sent, in the queue the action wanted: review on a fix, live on an Approve.
  const resend = route.slice(route.indexOf("const gone = /^Metricool 404"), route.indexOf("if (action === 'fix_citation') {\n        // The citation IS saved"));
  assert.match(resend, /gone && new Date\(nextDate\)\.getTime\(\) > Date\.now\(\)/);
  assert.match(resend, /metricoolSchedulePost\(\{[\s\S]{0,400}\}, mode\)/);
  assert.match(resend, /update\(\{ metricool_post_id: newId \}\)/);
  // An Approve that re-sent the post carries on to mark it approved rather than reporting an error.
  assert.match(route, /if \(!resent\) \{\s*return NextResponse\.json\(\s*\{\s*error: 'metricool_update_failed'/);
  // The client reloads on any fixed answer, Metricool's copy aside.
  const page = src('app/calendar/page.tsx');
  assert.match(page, /if \(j\?\.fixed\) \{[\s\S]{0,200}await refresh\(\)/);
});

test('"Verify / fix" runs by default at every door; the button is the safety net', () => {
  // A citation the judge has not accepted is repaired before the gate reads it,
  // wherever a post is approved, sent for review, published from a video or
  // approved by the Autopilot — and while the video copy is being prepared.
  const posts = src('app/api/posts/route.ts');
  const approve = posts.slice(posts.indexOf("if (action === 'approve' || action === 'publish_now') {\n    const fixed = await autoFixCitation("));
  assert.ok(approve.length > 0, 'the approve door runs it');
  assert.ok(approve.indexOf('await autoFixCitation(') < approve.indexOf('const gate = await complianceGate('), 'before the gate');
  assert.match(approve, /update\(\{ text: fixed\.text \}\)/, 'and the swap reaches the row');

  const schedule = src('app/api/metricool/schedule/route.ts');
  assert.ok(schedule.indexOf('await autoFixCitation(') < schedule.indexOf('const gate = await complianceGate('), 'send-for-review, before the gate');
  assert.match(schedule, /if \(fixed\.swapped\) text = fixed\.text;/);

  const publish = src('lib/video-publish.ts');
  assert.ok(publish.indexOf('await autoFixCitation(') < publish.indexOf('const gate = await complianceGate('), 'video publish, before the gate');
  assert.doesNotMatch(publish.slice(publish.indexOf('const gate = await complianceGate(')), /input\.text/, 'everything after it sends the corrected text');

  const ap = src('lib/autopilot.ts');
  const door = ap.slice(ap.indexOf('export async function approveRun'));
  assert.ok(door.indexOf('await autoFixCitation(') < door.indexOf('const plan = perNetworkPlan('), 'Autopilot approve, before the sends are planned');
  const score = ap.slice(ap.indexOf('async function stepScore'), ap.indexOf('export async function approveRun'));
  assert.match(score, /stamp\.status !== 'supported'[\s\S]{0,600}await autoFixCitation\(/, 'and at draft time, before the card is shown');

  const prepare = src('lib/video-prepare.ts');
  assert.match(prepare, /findBackingByClaims\(\{\s*text: tiktok,/, 'the video pipeline judges statement by statement too');

  // The helper only ever checks a post that cites something, and fails open.
  const auto = src('lib/citation-autofix.ts');
  assert.match(auto, /if \(!cited\) return unchanged;/);
  assert.match(auto, /catch \(err\) \{[\s\S]{0,200}return unchanged;/);
  // The button is still there.
  assert.match(src('app/calendar/page.tsx'), /'Verify \/ fix'/);
});

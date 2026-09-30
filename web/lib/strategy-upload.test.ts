// "Drop weekly strategy": what the model reads out of a PDF becomes Autopilot
// slots — clamped, additive, never written twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_ANGLES, MAX_SLOTS, UPLOAD_MARK, UPLOAD_SCHEMA, normalizeUpload, planUpload, ruleFor, timeOf, uploadRows, uploadSummary, slotsIn } from './strategy-upload.ts';
import { normalizeStrategy } from './template-strategy.ts';
import { citationPolicyFor, isStrategySlot, uploadVarietyKey, usesStrategyVoice } from './strategy-voice.ts';
import { attachableClip } from './clip-relevance.ts';

// Trimmed from what the reader returns for the clinic's own document.
const READ = {
  title: 'Cellular Institute — Weekly Social Content Strategy',
  summary: 'Fourteen posts a week, two a day, rotating pillars.',
  direction: 'Educational and personalized; no cure claims.',
  slots: [
    { day: 'mon', time: '09:00', pillar: 'Diagnosis and comprehensive assessment', angles: ['Why assessment comes first', 'What a full panel shows'], format: 'social', channels: ['instagram', 'facebook', 'linkedin'], rule: '' },
    { day: 'mon', time: '', pillar: 'Personalized protocols', angles: ['One size does not fit all'], format: 'social', channels: [], rule: 'Never promise identical outcomes.' },
    { day: 'mon', time: '', pillar: 'Weekly article', angles: ['The science of recovery'], format: 'blog', channels: ['blog'], rule: '' },
    { day: 'sun', time: '6:30 PM', pillar: 'Recovery in Cancun', angles: ['Rest by the sea', 'rest by the sea'], format: 'social', channels: ['instagram', 'tiktok'], rule: '' },
    { day: 'funday', time: '09:00', pillar: 'Lost', angles: [], format: 'social', channels: [], rule: '' },
    { day: 'tue', time: '09:00', pillar: '', angles: [], format: 'social', channels: [], rule: '' },
  ],
};

test('times in the ways a document writes them', () => {
  assert.equal(timeOf('09:00'), '09:00');
  assert.equal(timeOf('9:00'), '09:00');
  assert.equal(timeOf('9am'), '09:00');
  assert.equal(timeOf('6:30 PM'), '18:30');
  assert.equal(timeOf('12 am'), '00:00');
  assert.equal(timeOf('18.00'), '18:00');
  assert.equal(timeOf('9'), null, 'a bare number is not a time');
  assert.equal(timeOf('25:00'), null);
  assert.equal(timeOf(''), null);
});

test('the reader\'s answer is made safe: days, times, channels, angles', () => {
  const p = normalizeUpload(READ);
  assert.equal(p.slots.length, 4, 'the slot with no day and the one with no pillar are dropped');
  assert.equal(p.notes.length, 2);
  // Monday first, Sunday last.
  assert.deepEqual(p.slots.map((s) => s.weekday), [1, 1, 1, 0]);
  const [diag, article, protocols, sunday] = p.slots;
  assert.equal(diag.time, '09:00');
  assert.equal(article.format, 'blog');
  assert.equal(article.time, '11:00', 'an article without a time gets the article hour');
  assert.deepEqual(article.providers, ['blog', 'facebook', 'linkedin']);
  assert.equal(protocols.time, '18:00', 'the second social post of the day without a time gets 18:00');
  assert.deepEqual(protocols.providers, ['instagram', 'facebook', 'linkedin'], 'no channels named → the three');
  assert.equal(sunday.time, '18:30');
  assert.deepEqual(sunday.providers, ['instagram'], 'a channel the dashboard does not publish to is dropped');
  assert.deepEqual(sunday.angles, ['Rest by the sea'], 'angles de-duplicated');
});

test('an empty or hostile answer yields nothing to create', () => {
  assert.equal(normalizeUpload(null).slots.length, 0);
  assert.equal(normalizeUpload({ slots: 'x' }).slots.length, 0);
  const many = normalizeUpload({ slots: Array.from({ length: 40 }, (_, i) => ({ day: 'mon', time: String(i % 24).padStart(2, '0') + ':' + String(i).padStart(2, '0'), pillar: 'P' + i, angles: Array.from({ length: 30 }, (_, j) => 'a' + j) })) });
  assert.equal(many.slots.length, MAX_SLOTS);
  assert.ok(many.slots.every((s) => s.angles.length === MAX_ANGLES));
});

test('rows are pillars templates the engine reads back unchanged, marked as uploaded', () => {
  const rows = uploadRows(normalizeUpload(READ));
  for (const r of rows) {
    assert.equal(r.active, true);
    assert.equal(r.strategy.mode, 'pillars');
    assert.equal(r.strategy.seeded, UPLOAD_MARK);
    const n = normalizeStrategy(r.strategy);
    assert.equal(n.mode, 'pillars');
    assert.equal(n.seeded, UPLOAD_MARK);
    assert.deepEqual(n.pillars, r.strategy.pillars);
    assert.equal(n.slot, undefined, 'never mistaken for one of the built-in strategy\'s slots');
  }
  assert.match(String(rows.find((r) => r.name === 'Personalized protocols')?.strategy.rule), /Never promise identical outcomes\. The strategy's editorial direction: Educational/);
  assert.ok((ruleFor({ weekday: 1, time: '09:00', pillar: 'x', theme: '', angles: [], format: 'social', providers: [], rule: 'r'.repeat(900) }, 'd') || '').length <= 800);
});

test('uploaded slots cite a study only when a post makes a health claim, and are not the built-in strategy', () => {
  const s = uploadRows(normalizeUpload(READ))[0].strategy;
  assert.equal(citationPolicyFor(s), 'if-health-claim');
  assert.equal(isStrategySlot(s), false);
  assert.equal(citationPolicyFor({ seeded: undefined }), 'required', 'everything else unchanged');
});

test('every dropped strategy is written like the weekly strategy', () => {
  const s = uploadRows(normalizeUpload(READ))[0].strategy;
  assert.equal(usesStrategyVoice(s), true, 'uploaded slots get the strategy voice');
  assert.equal(usesStrategyVoice({ seeded: 'weekly-strategy' }), true);
  assert.equal(usesStrategyVoice({ mode: 'pillars', pillars: ['a'] } as { seeded?: unknown }), false, 'hand-written templates are unchanged');
  // Image-only, like the built-in strategy: a stored clip is never attached.
  const clip = { url: 'https://x/clip.mp4', title: 'Nutrition and recovery', relevant: true };
  assert.equal(attachableClip({ media: clip, query: 'Nutrition', seedTopic: 'Nutrition' }, s, 'Nutrition'), null);
  // Its place in the week picks its format / reader / closing rotation.
  assert.equal(uploadVarietyKey([2], '09:00'), 'tue-1');
  assert.equal(uploadVarietyKey([0], '18:30'), 'sun-2');
  assert.equal(uploadVarietyKey([], '09:00'), null);
});

test('the Autopilot applies the strategy voice to every uploaded slot', () => {
  const src = readFileSync(new URL('./autopilot.ts', import.meta.url), 'utf8');
  // No keyword swaps: movers skipped, the angle kept, no keyword brief.
  assert.match(src, /if \(!usesStrategyVoice\(strategy\)\) \{\n    try \{\n      movers = await keywordMovers/);
  assert.match(src, /if \(usesStrategyVoice\(strategy\)\) \{\n    const pool = seedPool\.length/);
  assert.match(src, /if \(!usesStrategyVoice\(strategy\)\) \{\n    try \{\n      brief = await buildKeywordBrief/);
  // The voice, the promotion rewrite, the image-only rule.
  assert.match(src, /const strategySlot = usesStrategyVoice\(strategy\);\n  const citationPolicy = citationPolicyFor/);
  assert.match(src, /const strategySlot = usesStrategyVoice\(strategy\);\n  \/\/ The openings of the recent posts/);
  assert.match(src, /const media = usesStrategyVoice\(strategy\) \? null/);
  assert.match(src, /if \(usesStrategyVoice\(strategy\)\) \{\n    \/\/ Rules, day theme/);
  // Weekly variety and no repeats across the week.
  assert.match(src, /uploadKey \? varietyFor\(uploadKey, weekIndex\(run\.scheduled_for\)\)/);
  assert.match(src, /coveredThisWeek: dealt \? siblingAngles\(strategy\.slot \|\| '', dealt\.week\) : uploadCovered/);
  // The built-in document's own rotation still needs its own slot key.
  assert.match(src, /if \(isStrategySlot\(strategy\) && strategy\.slot\) \{/);
});

test('the day theme, the post\'s notes and the direction all reach the writer; notes are never cut for the direction', () => {
  const plan = normalizeUpload({ ...READ, mix: '5 medical, 5 lifestyle, 2 recovery, 2 Cancun', slots: [
    { day: 'thu', time: '', pillar: 'Cancun and health tourism', theme: 'Prevention and destination', angles: ['Air connectivity'], format: 'social', channels: [], rule: 'Positioning note: avoid claiming Cancun is categorically better than every other Mexican destination.' },
  ] });
  assert.equal(plan.mix, '5 medical, 5 lifestyle, 2 recovery, 2 Cancun');
  const rule = String(uploadRows(plan)[0].strategy.rule);
  assert.match(rule, /^Day theme: Prevention and destination\. Positioning note: avoid claiming Cancun/);
  assert.match(rule, /editorial direction: Educational/);
  const long = ruleFor({ weekday: 4, time: '09:00', pillar: 'x', theme: 't', angles: [], format: 'social', providers: [], rule: 'NOTE '.repeat(80) }, 'D'.repeat(400));
  assert.ok(String(long).includes('NOTE '.repeat(80).trim()), 'the note survives whole; the direction is what is shortened');
});

test('insert-only: an earlier upload is skipped, a clash is reported, nothing is updated', () => {
  const plan = normalizeUpload(READ);
  const existing = [
    // Named differently by an earlier reading of the same document: still the same slot.
    { name: 'Diagnosis and assessment', weekdays: [1], time_of_day: '09:00:00', active: true, strategy: { seeded: UPLOAD_MARK } },
    { name: 'Nutrition', weekdays: [0], time_of_day: '18:30', active: true, strategy: { seeded: 'weekly-strategy' } },
    { name: 'Paused one', weekdays: [1], time_of_day: '18:00', active: false, strategy: {} },
  ];
  const p = planUpload(plan, existing);
  assert.equal(p.already.length, 1);
  assert.equal(p.create.length, 3);
  assert.deepEqual(p.clashes, [{ slot: 'Sunday 6:30 PM · Recovery in Cancun', with: 'Nutrition' }], 'a paused template is no clash — and the time reads on the 12-hour clock');
  assert.deepEqual(Object.keys(p).sort(), ['already', 'clashes', 'create']);
  assert.match(uploadSummary(p), /3 weekly slots created.*review queue/);
});

test('the schema is closed and asks for every key', () => {
  assert.equal(UPLOAD_SCHEMA.additionalProperties, false);
  assert.equal(UPLOAD_SCHEMA.properties.slots.items.additionalProperties, false);
  assert.deepEqual([...UPLOAD_SCHEMA.properties.slots.items.required].sort(), Object.keys(UPLOAD_SCHEMA.properties.slots.items.properties).sort());
  assert.deepEqual([...UPLOAD_SCHEMA.required].sort(), Object.keys(UPLOAD_SCHEMA.properties).sort());
});

test('the route reads the PDF with Claude, then inserts only — and the panel is on both pages', () => {
  const route = readFileSync(new URL('../app/api/templates/strategy-upload/route.ts', import.meta.url), 'utf8');
  assert.match(route, /type: 'document', source: \{ type: 'base64', media_type: 'application\/pdf'/);
  assert.match(route, /output_config: \{ format: \{ type: 'json_schema', schema: UPLOAD_SCHEMA \} \}/);
  assert.match(route, /checkRateLimit\(auth\.userId, 'templates'\)/);
  assert.match(route, /requireAllowlistedUser\(\)/);
  assert.match(route, /normalizeUpload\(body\.plan\)/, 'the plan sent back is never trusted as it arrives');
  assert.match(route, /\.insert\(insert\)/);
  assert.doesNotMatch(route, /\.delete\(|\.upsert\(/, 'additive: nothing existing is changed');
  assert.doesNotMatch(route, /from\('templates'\)[\s\S]{0,300}?\.update\(/, 'no template is ever updated');
  // The only updates the route makes are to the drafts it writes itself (the judge's stamp, a fixed citation), by id and owner.
  for (const m of route.matchAll(/\.update\(([^)]*)\)/g)) assert.match(route.slice(m.index, m.index + 120), /\.eq\('id', draftId\)\.eq\('user_id', auth\.userId\)/, m[0]);
  assert.match(route, /\.update\(\{ pack \}\)\.eq\('id', draftId\)\.eq\('user_id', auth\.userId\)/);
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{!isDraft && <StrategyDrop \/>\}/);
  // The top panel on the overview: above the panels grid and every other panel.
  const drop = page.indexOf('{!isDraft && <StrategyDrop />}');
  assert.ok(drop < page.indexOf('<SystemStatus />'), 'above the status banner too');
  assert.ok(drop < page.indexOf('<div className="2xl:grid 2xl:grid-cols-2'), 'before the panels grid');
  assert.equal(page.split('<StrategyDrop').length, 2, 'mounted once');
  const templates = readFileSync(new URL('../app/templates/page.tsx', import.meta.url), 'utf8');
  assert.match(templates, /<StrategyDrop onCreated=/);
  assert.match(templates, /<WeeklyPlanner/, 'the built-in strategy loader stays');
});

test('a strategy PDF may be 30 MB: anything over the request limit goes through storage', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const lib = src('lib/strategy-upload.ts');
  assert.match(lib, /export const UPLOAD_MAX_BYTES = 30 \* 1024 \* 1024;/);
  assert.match(lib, /export const DIRECT_MAX_BYTES = 4 \* 1024 \* 1024;/, 'the request-body limit stays what Vercel allows');
  const route = src('app/api/templates/strategy-upload/route.ts');
  assert.match(route, /body\.action === 'sign'/, 'the route issues a signed upload URL');
  assert.match(route, /createSignedUploadUrl\(path\)/);
  assert.match(route, /public: false/, 'the bucket is private');
  assert.match(route, /if \(!path\.startsWith\(auth\.userId \+ '\/'\) \|\| path\.includes\('\.\.'\)\)/, 'only the user’s own object is read');
  assert.match(route, /\.remove\(\[path\]\)/, 'and it is removed once read');
  assert.match(route, /buf\.length > UPLOAD_MAX_BYTES/, 'the cap is enforced on the bytes read, whichever way they came');
  const panel = src('components/StrategyDrop.tsx');
  assert.match(panel, /file\.size > DIRECT_MAX_BYTES/);
  assert.match(panel, /uploadToSignedUrl\(path, token, file/);
  assert.doesNotMatch(panel, /up to 4 MB/);
});

test('every post of the uploaded week can be previewed, edited and added to before it is created', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const panel = src('components/StrategyDrop.tsx');
  assert.match(panel, /Preview &amp; edit/);
  assert.match(panel, /role="dialog" aria-label="Post preview"/, 'opens in the same kind of panel the calendar uses');
  assert.match(panel, /aria-label=\{'Angle ' \+ \(i \+ 1\)\}/, 'every angle is a field, in full');
  assert.match(panel, /aria-label="Day"/);
  assert.match(panel, /\+ Add a post/);
  assert.match(panel, /Remove post/);
  // Curly quotes are characters, never the text "\\u201c" on screen.
  assert.doesNotMatch(panel, /\\u201c/);
  // What was edited is what is created, minus the editor's own fields.
  assert.match(panel, /slots\.filter\(\(sl\) => sl\.on\)\.map\(\(\{ _k: _key, on: _on, \.\.\.rest \}\) => rest\)/);
  assert.match(panel, /plan: \{ \.\.\.plan, slots: chosen \}/);
});

test('a week the reader wrote day by day still becomes slots', () => {
  const raw = {
    title: 'Weekly Social Content Strategy',
    days: [
      { day: 'monday', theme: 'Understand before treating', posts: [
        { time: '09:00', pillar: 'Diagnosis and assessment', angles: ['Why effective care begins with a thorough evaluation'], format: 'social', channels: ['instagram', 'facebook', 'linkedin'], rule: '' },
        { time: '18:00', pillar: 'Personalization', angles: ['Why one protocol does not work the same way for every person'], format: 'social', channels: [], rule: '' },
      ] },
      { day: 'tuesday', theme: 'Support the body from within', slots: [
        { pillar: 'Nutrition', angles: ['The role of protein in recovery'] },
      ] },
    ],
  };
  assert.equal(slotsIn(raw).length, 3);
  const plan = normalizeUpload(raw);
  assert.equal(plan.slots.length, 3);
  assert.equal(plan.slots[0].weekday, 1);
  assert.equal(plan.slots[0].theme, 'Understand before treating', 'the day’s theme is carried onto its posts');
  assert.equal(plan.slots[2].pillar, 'Nutrition');
  // The flat shape still works exactly as before.
  assert.equal(normalizeUpload({ slots: [{ day: 'wed', pillar: 'Movement', angles: ['x'] }] }).slots.length, 1);
  assert.equal(normalizeUpload({}).slots.length, 0);
});

test('an empty first reading is asked again, firmly, and a short upload is refused', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/templates/strategy-upload/route.ts');
  assert.match(route, /if \(!normalizeUpload\(raw\)\.slots\.length\) \{[\s\S]{0,600}readStrategyPdf\(buf, \{ insist: true \}\)/);
  assert.match(route, /INSIST_PROMPT/);
  assert.match(route, /on two readings/, 'and the refusal says it tried twice, in the reader’s own words');
  assert.match(route, /buf\.length !== expectedSize/, 'a cut-off storage upload is never read as the strategy');
  assert.match(src('components/StrategyDrop.tsx'), /action: 'read', path, size: file\.size/);
});

test('a slot can be written for real from the panel: the whole post, its picture, saved under Recent Drafts', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/templates/strategy-upload/route.ts');
  const draft = route.slice(route.indexOf("if (body.action === 'draft') {"), route.indexOf("if (body.action === 'picture') {"));
  assert.match(draft, /strategyTopicPrompt\(\{ angle, pillarName: slot\.pillar, rule: ruleFor\(slot, plan\.direction\)/, 'the strategy’s own brief');
  assert.match(draft, /strategyBrand\(brand, \{ citation: 'if-health-claim' \}\)/, 'the strategy’s voice');
  assert.match(draft, /competitiveBrief\(/, 'against the top three');
  assert.match(draft, /\.from\('drafts'\)[\s\S]{0,80}\.insert\(/, 'saved like any other draft');
  assert.doesNotMatch(draft, /ensureDraftImage\(/, 'the copy goes back first; the picture is its own request');
  const picture = route.slice(route.indexOf("if (body.action === 'picture') {"), route.indexOf("if (body.action !== 'apply')"));
  assert.match(picture, /ensureDraftImage\(draftId, auth\.userId/, 'with its picture, second');
  const panel = src('components/StrategyDrop.tsx');
  const api = src('components/slotPreview.ts');
  assert.match(panel, /Write a preview post/);
  // The requests live in one place (components/slotPreview.ts), shared with a template's Preview.
  assert.match(panel, /requestDraft\(plain, plan\?\.direction \|\| '', angle, scopeFor\(k\)\)/);
  assert.match(api, /action: 'draft', slot, direction, angle/);
  assert.match(panel, /Open in Recent Drafts/);
  // Only the post's own box shows the loader, the work survives closing the panel, and the card says so.
  assert.match(panel, /PanelLoader scope=\{scopeFor\(slot\._k\)\}/);
  assert.match(api, /'x-chi-progress-scope': scope/);
  assert.match(panel, /const \[previews, setPreviews\] = useState<Record<string, PreviewDraft>>/, 'kept above the panel');
  assert.match(panel, /Writing the post…/);
  assert.match(panel, /Post written/);
  // At the document root, and written as it opens.
  assert.match(panel, /createPortal\(\s*<SlotPanel/, 'a fixed dialog inside the dashboard’s animated panels is otherwise positioned off-screen');
  assert.match(panel, /autoStarted\.current\.add\(k\);\s*void writePreview\(openSlot, openSlot\.angles\[0\] \|\| ''\);/);
});

test('the week is written as soon as it is read, two posts at a time, on its own allowance', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const panel = src('components/StrategyDrop.tsx');
  assert.match(panel, /void writeWeek\(laidOut\);/, 'starts the moment the week is on screen');
  assert.match(panel, /await Promise\.all\(\[worker\(\), worker\(\)\]\)/, 'two at a time');
  assert.match(panel, /if \(!sl \|\| previewsRef\.current\[sl\._k\] \|\| writingRef\.current\[sl\._k\]\) continue;/, 'never twice');
  assert.match(panel, /Writing the week/);
  const route = src('app/api/templates/strategy-upload/route.ts');
  assert.match(route, /writingPosts \? 'strategy-draft' : 'templates'/);
  assert.match(src('lib/rate-limit.ts'), /'strategy-draft': \{ limit: 150, windowSec: 3600 \}/);
});

test('a previewed post is approved and fixed at draft time like every other post: keywords in place, citation judged and repaired', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/templates/strategy-upload/route.ts');
  const draft = route.slice(route.indexOf("if (body.action === 'draft') {"), route.indexOf("if (body.action === 'picture') {"));
  // No keywords, no post — said as such.
  assert.match(draft, /if \(e instanceof NoKeywordsError\) \{\s*return fail\(422, 'no_keywords'/);
  // The judge, then the automatic fix when it did not approve, then the stamp on the draft.
  assert.match(draft, /let stamp = await strategyClaimSupport\(pack\);/);
  assert.match(draft, /if \(stamp && stamp\.status !== 'supported'\) \{\s*const fixed = await autoFixCitation\(\{ userId: auth\.userId, draftId, text: caption, pack, budgetMs: 60_000 \}\);/);
  assert.match(draft, /pack\._claimSupport = stamp;[\s\S]{0,200}\.from\('drafts'\)\.update\(\{ pack \}\)/);
  // Keywords, last check, and the same refusal the door uses.
  assert.match(draft, /await ensureKeywords\(\{ userId: auth\.userId, draftId, text: caption, pack \}\)/);
  assert.match(draft, /const checks = checksFor\(pack, fixNote\);/);
  assert.match(route, /held: claimSupportRefusal\(status\),/, 'the same refusal the door uses');
  assert.match(draft, /checks \}\);\s*$/m, 'the verdict goes back to the panel');
  // One judge for the Autopilot and the preview.
  const shared = src('lib/strategy-claim-support.ts');
  assert.match(shared, /export async function strategyClaimSupport\(/);
  assert.match(shared, /if \(index < 0 \|\| !items\.length\) return \{ status: 'unchecked', doi: cited \};/);
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /import \{ strategyClaimSupport \} from '@\/lib\/strategy-claim-support';/);
  assert.doesNotMatch(autopilot, /async function strategyClaimSupport\(/, 'moved, not copied');
  // The panel shows what was checked, and a held post says so on its card.
  const panel = src('components/StrategyDrop.tsx');
  assert.match(panel, /draft\.checks\.keywords\.length \? draft\.checks\.keywords\.slice\(0, 8\)\.join\(', '\) : 'none could be researched'/);
  assert.match(panel, /\{draft\.checks\.citation\}/);
  assert.match(panel, /Written, citation held/);
});

test('a previewed post has an editor, a Verify / fix button and its picture, like every other preview', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/templates/strategy-upload/route.ts');
  // The picture gets the function's time, and a failure comes back with its reason.
  const picture = route.slice(route.indexOf("if (body.action === 'picture') {"), route.indexOf("if (body.action === 'fix') {"));
  assert.match(picture, /budgetMs: PICTURE_BUDGET_MS/);
  assert.match(route, /const PICTURE_BUDGET_MS = 240_000;/);
  assert.match(route, /export const maxDuration = 300;/);
  assert.match(picture, /const again = Boolean\(\(body as \{ again\?: unknown \}\)\.again\);[\s\S]{0,400}force: true,/, 'make it again');
  assert.match(picture, /reason = 'The picture could not be made: '/);
  assert.match(picture, /if \(!imagesEnabled\(\)\) return NextResponse\.json\(\{ draftId, image: null, reason:/);
  // Verify / fix on the draft: the same ladder as the calendar's button, saved on the draft, checks handed back.
  const fix = route.slice(route.indexOf("if (body.action === 'fix') {"), route.indexOf("if (body.action !== 'apply')"));
  assert.match(fix, /fixPostCitation\(\{ text: captionOf\(pack\), pack, aviso: await avisoForUser\(auth\.userId\), budgetMs: FIX_BUDGET_MS \}\)/);
  assert.match(fix, /checks: checksFor\(next\)/);
  assert.match(route, /body\.action === 'draft' \|\| body\.action === 'picture' \|\| body\.action === 'fix'/, 'on the writing allowance');
  const panel = src('components/StrategyDrop.tsx');
  const api = src('components/slotPreview.ts');
  // The editor: one box per channel, saved through the drafts API like Recent Drafts saves.
  assert.match(panel, /<textarea aria-label=\{c\.label \+ ' copy'\}/);
  assert.match(api, /fetch\('\/api\/drafts', \{ method: 'PATCH'/);
  assert.match(panel, /requestSave\(cur\.draftId, \{ \.\.\.cur\.pack, \.\.\.edits \}\)/);
  assert.match(panel, /Save changes/);
  // The buttons, and the reason when there is no picture.
  assert.match(panel, /\{writing === 'fix' \? 'Checking…' : 'Verify \/ fix'\}/);
  assert.match(panel, /draft\.image\?\.url \? 'Make an AI picture instead' : 'Make the picture'/);
  assert.match(api, /action: 'picture', draftId, again/);
  assert.match(api, /action: 'fix', draftId/);
  assert.match(api, /imageNote: out\.reason \|\| 'The picture could not be made just now\.'/);
  assert.match(panel, /withPicture\(p\[k\], out\)/);
  assert.match(panel, /makePicture\(sl, false, \{ draftId: made\.draftId, keepBusy: true \}\)/, 'the id is passed, not read off stale state');
});

test('the week can be paused from the page, and its pictures cost a quarter', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const panel = src('components/StrategyDrop.tsx');
  // Pause: on the badge (lib/pause-bus.test.ts) and beside the progress line; pictures can be switched off.
  assert.match(panel, /\{paused \? 'Resume' : 'Pause'\}/);
  assert.match(panel, /Nothing new is started until you resume\./);
  assert.match(panel, /Pictures while writing/);
  assert.match(panel, /localStorage\.setItem\(PICTURES_KEY/);
  // A preview's first picture is medium quality with one take; "again" is the real thing.
  const route = src('app/api/templates/strategy-upload/route.ts');
  // The library first; a generated preview picture (medium, one take) only when no photograph fits; "again" is a high-quality AI take.
  assert.match(route, /pictureForDraft\(draftId, auth\.userId, \{ budgetMs: PICTURE_BUDGET_MS, quality: 'medium', maxAttempts: 1 \}\)/);
  assert.match(route, /ensureDraftImage\(draftId, auth\.userId, \{ force: true, budgetMs: PICTURE_BUDGET_MS, quality: 'high', maxAttempts: 2 \}\)/);
  const images = src('lib/images.ts');
  assert.match(images, /const attempts = quality === 'medium' \? ladder\.filter\(\(a\) => a\.body\.quality !== 'high'\) : ladder;/);
  assert.match(images, /const maxAttempts = Math\.max\(1, Math\.min\(MAX_GEN_ATTEMPTS, Math\.round\(opts\.maxAttempts \?\? MAX_GEN_ATTEMPTS\)\)\);/);
  assert.match(images, /generateImageBytes\(prompt, planner\?\.size, callMs\(\), deadline, opts\.quality \?\? 'high'\)/);
  // Every other caller is unchanged: high, three takes.
  assert.doesNotMatch(src('lib/autopilot.ts'), /quality: 'medium'/);
  assert.match(panel, /a preview picture was made at medium quality/);
  assert.match(panel, /The clinic&rsquo;s own photograph, from the Image Library/);
});

test('the clinic’s own photographs come first, and no photograph is repeated within 45 days', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  // One door for every automatic picture: the Autopilot's draft and approve steps, and the strategy preview.
  const door = src('lib/draft-picture.ts');
  assert.match(door, /const pick = await libraryPhotoFor\(\{ pack, topic: String\(row\.topic \|\| ''\), brand, budgetMs/);
  assert.match(door, /const made = await ensureDraftImage\(draftId, ownerId, \{ budgetMs: opts\.budgetMs, quality: opts\.quality, maxAttempts: opts\.maxAttempts \}\);/, 'generated only after the library declined');
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /await pictureForDraft\(draftId, run\.user_id\)/);
  assert.match(autopilot, /shippable\(\(await pictureForDraft\(run\.draft_id, run\.user_id\)\)\.image\)/);
  // The picker: the post's pillar (planner, or its words), a fresh photograph, the same grading as a manual pick, and the use remembered.
  const pick = src('lib/library-pick.ts');
  assert.match(pick, /pickFresh\(candidates, pillars, Date\.now\(\), \{ exclude: opts\.excludeFileId \? \[opts\.excludeFileId\] : \[\] \}\)/);
  assert.match(pick, /libraryHero\(\{ url, title: Boolean\(planner\), pack: opts\.pack, topic: opts\.topic, brand: opts\.brand, libraryFileId: row\.file_id, libraryName: row\.name \}\)/);
  assert.match(pick, /await touchLibraryUse\(row\.file_id\);/);
  assert.match(src('lib/library-topic.ts'), /export const REUSE_WINDOW_DAYS = 45;/);
  // A manual pick counts as a use too.
  assert.match(src('app/api/drafts/image/route.ts'), /if \(libraryFileId\) void touchLibraryUse\(libraryFileId\);/);
  // The index: a table the health check knows, filled from the Image Library page and topped up on the way.
  assert.match(src('supabase/library-photos.sql'), /create table if not exists public\.library_photos/);
  assert.match(src('lib/schema-probe.ts'), /table: 'library_photos'/);
  assert.match(src('components/SourcesView.tsx'), /Read the library for automatic pictures/);
  assert.match(pick, /indexLibrary\(\{ max: TOP_UP/);
  // "Pick image from library" on the strategy preview and the Autopilot card.
  assert.match(src('components/StrategyDrop.tsx'), /📁 Pick image from library/);
  assert.match(src('app/AutopilotQueue.tsx'), /📁 Pick image from library · free/);
  assert.match(src('components/LibraryPicker.tsx'), /action: 'import_image', fileId: img\.id/);
});

// ---- slotFromTemplate: a saved template previewed as a strategy slot ----
import { slotFromTemplate } from './strategy-upload.ts';

test('slotFromTemplate: a pillars template becomes the slot its post is written from', () => {
  const slot = slotFromTemplate({
    name: 'Sleep, stress and rest', weekdays: [1, 3], time_of_day: '09:00', providers: ['instagram', 'facebook', 'linkedin'],
    strategy: { mode: 'pillars', pillars: ['Cortisol and sleep', 'Rest as treatment'], rule: 'Never promote the lounge.', format: 'social' },
  });
  assert.ok(slot);
  assert.equal(slot.pillar, 'Sleep, stress and rest');
  assert.equal(slot.weekday, 1);
  assert.equal(slot.time, '09:00');
  assert.deepEqual(slot.angles, ['Cortisol and sleep', 'Rest as treatment']);
  assert.deepEqual(slot.providers, ['instagram', 'facebook', 'linkedin']);
  assert.equal(slot.format, 'social');
  assert.equal(slot.rule, 'Never promote the lounge.');
  // and the route's normaliser accepts it as it is
  assert.equal(normalizeUpload({ slots: [slot], direction: '' }).slots.length, 1);
});

test('slotFromTemplate: a fixed topic is the one angle; full auto writes about the name', () => {
  const fixed = slotFromTemplate({ name: 'Monday article', weekdays: [1], time_of_day: '11:00', providers: ['blog'], strategy: { mode: 'fixed_topic', topic: 'Stem cells for knees', format: 'blog' } });
  assert.deepEqual(fixed?.angles, ['Stem cells for knees']);
  assert.equal(fixed?.format, 'blog');
  assert.deepEqual(fixed?.providers, ['blog']);
  const auto = slotFromTemplate({ name: 'Recovery', weekdays: [], time_of_day: 'noon', providers: [], strategy: { mode: 'auto' } }, 4);
  assert.deepEqual(auto?.angles, ['Recovery']);
  assert.equal(auto?.weekday, 4, 'no days: previews as today');
  assert.equal(auto?.time, '09:00', 'an unreadable time falls back');
  assert.deepEqual(auto?.providers, ['instagram', 'facebook', 'linkedin'], 'no channels: the strategy channels');
});

test('slotFromTemplate: a static-text template has nothing to write', () => {
  assert.equal(slotFromTemplate({ name: 'Hours', weekdays: [1], time_of_day: '09:00', strategy: { mode: 'off' } }), null);
  assert.equal(slotFromTemplate({ name: 'Hours', weekdays: [1], time_of_day: '09:00' }), null);
});

// ---- "Preview" on a saved template: the same panel, the same post ----
test('a saved template can be previewed like any other draft: one post, written as it opens, in the strategy panel', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const page = src('app/templates/page.tsx');
  const preview = src('components/TemplatePreview.tsx');
  const panel = src('components/StrategyDrop.tsx');
  // The button, on every Autopilot template (a static-text one shows its text already).
  assert.match(page, /t\.strategy && t\.strategy\.mode !== 'off' && \(\s*<button[\s\S]{0,200}onClick=\{\(\) => setPreviewing\(t\)\}/);
  assert.match(page, /<TemplatePreview key=\{previewing\.id\} template=\{previewing\} onClose=/);
  // The template becomes the slot its post is written from, written the moment the panel opens, picture following.
  assert.match(preview, /slotFromTemplate\(template\)/);
  assert.match(preview, /requestDraft\(plain, '', angle, scopeFor\(slot\._k\)\)/);
  assert.match(preview, /void write\(slot\.angles\[0\] \|\| ''\)/, 'written as it opens');
  assert.match(preview, /if \(made\.draftId && !isPaused\(\)\) await picture\(false, made\.draftId, true\)/, 'the picture follows, unless paused');
  // In the same panel, with the same controls — and the template read-only in it.
  assert.match(preview, /<SlotPanel\s+fixed/);
  assert.match(preview, /onFix=\{\(\) => void fix\(\)\}/);
  assert.match(preview, /onSave=\{save\}/);
  assert.match(panel, /export function SlotPanel\(/);
  assert.match(panel, /\{!fixed && <button type="button" onClick=\{onRemove\}/);
  assert.match(panel, /Change the template above to change what it writes/);
});

test('every time of day on the site reads on the 12-hour clock', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  assert.match(src('app/templates/page.tsx'), /at \{fmtClock12\(t\.time_of_day \|\| '09:00'\)\}/);
  assert.match(src('components/WeeklyPlanner.tsx'), /\{fmtClock12\(t\.time_of_day\) \|\| '—'\}/);
  assert.match(src('app/calendar/page.tsx'), /fmtClock12\(e\.time, \{ compact: true \}\)/);
  const panel = src('components/StrategyDrop.tsx');
  assert.match(panel, /tabular-nums">\{fmtClock12\(slot\.time\)\}<\/span>/);
  assert.match(panel, /\{DAY_LABELS\[slot\.weekday\]\} · \{fmtClock12\(slot\.time\)\}/);
  assert.match(panel, /aria-label="Time" type="time"/, 'the browser’s own clock picker, which reads 12-hour too');
  assert.match(src('lib/schedule-clock.ts'), /export function fmtScheduleTime[\s\S]{0,80}hour: 'numeric'/);
  assert.match(src('lib/planner-admin.ts'), /' at ' \+ fmtClock12\(t\.time_of_day\) \+ ' \(Cancún\)'/, 'the assistant says times the same way');
});

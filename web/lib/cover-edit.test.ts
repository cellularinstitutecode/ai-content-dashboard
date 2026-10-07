// web/lib/cover-edit.test.ts
//
// "I need to be able to edit the AI-generated images — it's been giving me the
//  same titles. I must also be able to give it prompts after the image has
//  been generated. Have the panel open by default so we don't spend credits."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONFIRM_CREDITS_AFTER, NO_CLEAN_PHOTO, cleanCoverTitle, creditConfirmText, creditLabel, currentCoverTitle, fallbackTitles,
  needsCreditConfirm, notesOf, parseTitleList, retitleDecision, suggestTitlesPrompt, takesOf, titleOff,
} from './cover-edit.ts';
import { MAX_COVER_TITLE } from './planner-image.ts';
import { coverTitleFor } from './library-cover.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// --- RETITLE: FREE WHEN THE CLEAN PHOTOGRAPH IS THERE -------------------------

test('a titled cover is retitled from the clean photograph kept beside it', () => {
  const d = retitleDecision({ url: 'https://x/cover.png', titled: { title: 'Sleep and Recovery', photoUrl: 'https://x/photo.jpg' }, verification: { headTopPct: 41 } });
  assert.deepEqual(d, { ok: true, photoUrl: 'https://x/photo.jpg', headTopPct: 41 });
});

test('a picture from before covers existed cannot be retitled, and the button says why', () => {
  const d = retitleDecision({ url: 'https://x/old.jpg', source: 'generated' });
  assert.equal(d.ok, false);
  assert.equal((d as { reason: string }).reason, NO_CLEAN_PHOTO);
  assert.match(NO_CLEAN_PHOTO, /made before retitling existed — make a new image first/);
  assert.equal(retitleDecision(null).ok, false, 'no picture at all');
  assert.equal(retitleDecision({ url: '' }).ok, false);
});

test('an untitled library photo or upload IS the clean photograph, so a title can go on it', () => {
  const lib = retitleDecision({ url: 'https://x/lib.jpg', source: 'library' });
  assert.deepEqual(lib, { ok: true, photoUrl: 'https://x/lib.jpg', headTopPct: null });
  assert.equal(retitleDecision({ url: 'https://x/up.jpg', source: 'upload' }).ok, true);
});

test('the words on the cover: the set title first (even an empty one), else the planner’s', () => {
  assert.equal(currentCoverTitle({ url: 'u', titled: { title: 'Custom Words', photoUrl: 'p' } }, 'Planner Title'), 'Custom Words');
  assert.equal(currentCoverTitle({ url: 'u' }, 'Planner Title'), 'Planner Title');
  assert.equal(currentCoverTitle(null, null), '');
  // "No title on the image" is a title of '' on purpose, not a missing one.
  assert.equal(currentCoverTitle({ url: 'u', titled: { title: '', photoUrl: 'p' } }, 'Planner Title'), '');
  assert.equal(titleOff({ url: 'u', titled: { title: '', photoUrl: 'p' } }), true);
  assert.equal(titleOff({ url: 'u', titled: { title: 'Words', photoUrl: 'p' } }), false);
  assert.equal(titleOff({ url: 'u' }), false);
});

test('a title the team set outlives the picture: the brand-photo path reads it, "no title" included', () => {
  const pack = { _autopilot: { template_name: 'Nutrition', angle: { query: 'The role of protein in recovery' } }, _image: { url: 'u', titled: { title: 'My Own Words', photoUrl: 'p', custom: true } } };
  assert.equal(coverTitleFor(pack, 'topic'), 'My Own Words');
  assert.equal(coverTitleFor({ ...pack, _image: { url: 'u', titled: { title: '', photoUrl: 'p', custom: true } } }, 'topic'), '');
  // A cover the planner titled (not custom) still follows the planner.
  assert.equal(coverTitleFor({ ...pack, _image: { url: 'u', titled: { title: 'Protein and Recovery', photoUrl: 'p' } } }, 'topic'), 'Protein and Recovery');
});

test('a typed title is made fit for the cover', () => {
  assert.equal(cleanCoverTitle('  "Eating Well   Before Treatment."  '), 'Eating Well Before Treatment');
  assert.equal(cleanCoverTitle(null), '');
  const long = cleanCoverTitle('A Very Long Title That Goes On And On About Everything Under The Sun, Without Stopping');
  assert.ok(long.length <= MAX_COVER_TITLE, long);
  assert.doesNotMatch(long, /[,\s]$/);
});

// --- NOTES AND CREDITS ------------------------------------------------------------

test('the last notes come back to the panel; none is an empty string', () => {
  assert.equal(notesOf({ url: 'u', direction: '  two women at a table ' }), 'two women at a table');
  assert.equal(notesOf({ url: 'u' }), '');
  assert.equal(notesOf(null), '');
});

test('a credit is asked about only from the third generation on', () => {
  assert.equal(CONFIRM_CREDITS_AFTER, 3);
  assert.equal(takesOf({ url: 'u' }), 0);
  assert.equal(takesOf({ url: 'u', takes: 2 }), 2);
  assert.equal(takesOf({ url: 'u', takes: -4 }), 0);
  assert.equal(needsCreditConfirm(0), false);
  assert.equal(needsCreditConfirm(2), false, 'a first or second reroll asks nothing');
  assert.equal(needsCreditConfirm(3), true);
  assert.match(creditConfirmText(3, 4), /already had 4 image generations\. Spend 3 more credits/);
  assert.match(creditConfirmText(1, 3), /Spend 1 more credit on a new one\?/);
  assert.equal(creditLabel(1), '· 1 credit');
  assert.equal(creditLabel(3), '· 3 credits');
});

// --- TITLE SUGGESTIONS -------------------------------------------------------------

test('the suggester is briefed on the angle and the copy, and told what is already used', () => {
  const p = suggestTitlesPrompt({ angle: 'The role of protein in recovery', pillarName: 'Nutrition', copy: 'Protein helps #recovery', current: 'Protein and Recovery', avoid: ['Nutrition and Inflammation'] });
  assert.match(p, /ANGLE: The role of protein in recovery/);
  assert.match(p, /THEME: Nutrition/);
  assert.match(p, /ALREADY USED.*"Protein and Recovery".*"Nutrition and Inflammation"/);
  assert.match(p, /THE POST: Protein helps recovery/, 'the hashtag’s word stays, the sign goes');
});

test('the model’s answer is read as a list, cleaned, deduplicated and never the current title', () => {
  const list = parseTitleList('["Protein for Healing", "Protein and Recovery", "protein for healing", "Why Not Protein?", "Fuel for Repair."]', { avoid: ['Protein and Recovery'] });
  assert.deepEqual(list, ['Protein for Healing', 'Fuel for Repair']);
  assert.deepEqual(parseTitleList('1. Rest and Repair\n2. Building Back Strength\n- Protein at Every Meal\n4. One Too Many'), ['Rest and Repair', 'Building Back Strength', 'Protein at Every Meal']);
  assert.deepEqual(parseTitleList('Sure, here are some titles'), [], 'a preamble is not a title');
  assert.deepEqual(parseTitleList(''), []);
});

test('with no model at hand, the planner’s own framings are the suggestions', () => {
  const f = fallbackTitles('Protein and Recovery');
  assert.equal(f.length, 3);
  assert.ok(f.every((t) => t !== 'Protein and Recovery' && t.length <= MAX_COVER_TITLE), f.join(' | '));
  assert.deepEqual(fallbackTitles(''), []);
});

// --- THE APP USES IT -----------------------------------------------------------------

test('the route retitles from the clean photo, keeps the notes, counts takes — and spends nothing on the free ones', () => {
  const route = src('app/api/drafts/image/route.ts');
  assert.match(route, /const retitle = typeof body\?\.retitle === 'string' \? body\.retitle : body\?\.noTitle === true \? '' : null/, 'retitle, and "no title"');
  assert.match(route, /retitleImage\(existing, cleanCoverTitle\(retitle\)/);
  assert.match(route, /suggestTitles/, 'title suggestions');
  assert.match(route, /if \(suggestTitles\) \{[\s\S]{0,200}?checkRateLimit\(user\.id, 'title'\)/, 'a text-model call, capped like /api/title');
  // Retitling fetches the clean photo on the server: only from the app's own bucket.
  assert.match(src('lib/retitle.ts'), /import \{ fetchPhoto \} from '@\/lib\/library-hero'/);
  assert.match(src('lib/library-hero.ts'), /if \(!ownBucketUrl\(url, process\.env\.NEXT_PUBLIC_SUPABASE_URL, IMAGE_BUCKET\)\) throw/);
  assert.match(route, /const effectiveDirection = directionGiven \? direction : notesOf\(existing\)/, 'notes are reused until replaced');
  assert.match(route, /direction: effectiveDirection/, 'and reach generation');
  assert.match(route, /typeof body\?\.direction === 'string'/, 'the panel sends `direction`');
  assert.match(route, /saveNotes/, 'notes can be kept without a generation');
  assert.match(route, /title: existing\?\.titled\?\.custom \? existing\.titled\.title : null/, 'the set title stays on every new take');
  assert.match(route, /const takes = Math\.max\(takesOf\(priorImage\), takesOf\(existing\)\) \+ madeNow\.length;\n\s+nextHero\.takes = takes;/, 'the generation counter');
  assert.match(route, /export async function GET/, 'the panel reads the picture’s state');
  // The retitle branch runs BEFORE the rate limit and the credit-spending
  // generation: it never reaches them.
  const retitleAt = route.indexOf('if (retitle != null)');
  const rateLimitAt = route.indexOf("checkRateLimit(user.id, 'image')");
  assert.ok(retitleAt > -1 && retitleAt < rateLimitAt, 'retitle returns before any credit is spent');
  const block = route.slice(retitleAt, route.indexOf('// KEEP THE NOTES'));
  assert.doesNotMatch(block, /generatePackImage/);

  const retitle = src('lib/retitle.ts');
  assert.match(retitle, /renderTitleCover\(/, 'the cover is re-rendered by the app’s own renderer');
  assert.match(retitle, /fetchPhoto\(decision\.photoUrl\)/, 'from the clean photograph');
  assert.match(retitle, /headTopPct: decision\.headTopPct/, 'with the take’s head measurement');
  assert.doesNotMatch(retitle, /generateImageBytes|images\/generations|generatePackImage/, 'no image model');
  assert.match(retitle, /custom: true/);
});

test('the planner cover path stores the clean photograph beside the cover, so every future image can be retitled', () => {
  const images = src('lib/images.ts');
  const store = images.indexOf('const photoUrl = await storeImage(best.img, nameHint)');
  const cover = images.indexOf('renderTitleCover({ title: planner.title');
  assert.ok(store > -1 && store < cover, 'the photo is stored first, then titled');
  assert.match(images, /titled = \{ title: planner\.title, photoUrl, family: cover\.family/, 'and kept as titled.photoUrl');
  assert.match(images, /titled = \{ title: '', photoUrl, family: 'none', custom: true \}/, 'a title turned off is recorded, not forgotten');
  assert.match(images, /\.\.\.\(direction \? \{ direction \} : \{\}\)/, 'the notes are stamped on the take');
  assert.match(images, /direction: notesOf\(existing\) \|\| null/, 'and reused by the engine’s own reroll');
  const hero = src('lib/library-hero.ts');
  assert.match(hero, /titled = \{ title, photoUrl, family: cover\.family, \.\.\.\(custom \? \{ custom: true \} : \{\}\) \}/, 'library covers keep theirs too');
});

test('the notes edit the picture that is there, unless a new one is asked for', () => {
  // The notes field sat beside the picture and had nothing to do with it: it
  // fed a text-to-image prompt, and the stored photograph never reached the
  // model, so every note produced a different, unrelated photo.
  const images = src('lib/images.ts');
  const edit = images.slice(images.indexOf('export async function editPackImage('), images.indexOf('export async function ensureDraftImage('));
  assert.match(edit, /const decision = retitleDecision\(opts\.existing\)/, 'edits the clean photograph the free retitle uses');
  assert.match(edit, /fetchOwnPhoto\(sourceUrl\)/, 'fetched back from the app\'s own bucket');
  assert.match(edit, /editImageBytes\(prompt, photo, callMs\(\), deadline, opts\.quality \?\? 'high'\)/, 'the photograph goes up with the prompt');
  assert.match(edit, /verifyGeneratedImage\(img, subject, normalizeVisual\(opts\.brand\?\.visual\), planner\)/, 'checked like any take');
  assert.match(edit, /renderTitleCover\(\{ title: had\.title/, 'the title it had is set again');
  assert.match(edit, /editedFrom: sourceUrl/, 'and the record says what it was made from');
  const ladder = images.slice(images.indexOf('async function editImageBytes('), images.indexOf('async function fetchOwnPhoto('));
  assert.match(ladder, /input_fidelity: 'high'/, 'faces and detail of the photograph are kept');
  assert.match(ladder, /form\.append\('size', 'auto'\)/, 'the photograph keeps its own shape');
  assert.match(ladder, /form\.append\('image', new Blob/, 'as multipart, with the bytes');
  assert.match(images, /'https:\/\/api\.openai\.com\/v1\/images\/' \+ endpoint/, 'edits and generations share one call');
  assert.match(images, /return postImages\('edits', form, timeoutMs\)/);
  const fetchOwn = images.slice(images.indexOf('async function fetchOwnPhoto('), images.indexOf('// Verification: a vision model'));
  assert.match(fetchOwn, /ownBucketUrl\(url, process\.env\.NEXT_PUBLIC_SUPABASE_URL, IMAGE_BUCKET\)/, 'only the app\'s own storage');

  // The route: a regenerate with a picture in place edits it; `fresh`, a set,
  // a proposition, or a picture with nothing to edit from makes a new one.
  const route = src('app/api/drafts/image/route.ts');
  assert.match(route, /const startFresh = body\?\.fresh === true/);
  assert.match(route, /const editing = regenerate && !startFresh && wantSet === 0 && !asOption && Boolean\(existing\?\.url\) && !existingHasText && retitleDecision\(existing\)\.ok/);
  assert.match(route, /image = await editPackImage\(\{ existing, topic, pack, brand, direction: effectiveDirection \}\)/);
  assert.match(route, /error: 'edit_failed'/, 'a failed edit is the answer, never a quietly made new picture');
  assert.match(route, /Start from a new picture instead/, 'and it says how to ask for one');

  // The panel edits by default; the hosts' own "New image" buttons say fresh.
  const panel = src('components/ImageEditPanel.tsx');
  assert.match(panel, /const fresh = wantFresh \|\| !editable/, 'a draft with nothing to edit from can only get a new picture');
  assert.match(panel, /regenerate: true, direction: notes\.trim\(\), fresh/);
  assert.match(src('components/HeroImageControls.tsx'), /send\(\{ regenerate: true, fresh: true \}/);
  assert.match(src('app/AutopilotQueue.tsx'), /editImage\(r, \{ regenerate: true, fresh: true \}/);
});

test('the Edit image panel is open by default on the Dashboard card and in the Calendar preview', () => {
  const panel = src('components/ImageEditPanel.tsx');
  assert.doesNotMatch(panel, /useState<boolean>\(false\)|open \? |setOpen\(/, 'nothing to click open');
  assert.match(panel, /Title on the image/);
  assert.match(panel, /retitle: words/, 'Apply title');
  assert.match(panel, /retitle: ''/, 'No title on the image');
  assert.match(panel, /No title on the image/);
  assert.match(panel, /suggestTitles: true/, 'Title suggestions');
  assert.match(panel, /Notes for the picture/);
  assert.match(panel, /regenerate: true, direction: notes\.trim\(\), fresh/, 'Edit this picture with these notes — and whether to start afresh');
  assert.match(panel, /\(fresh \? 'Make a new picture with these notes ' : 'Edit this picture with these notes '\) \+ creditLabel\(1\)/, 'and it says it spends a credit, whichever it does');
  assert.match(panel, /Start from a new picture instead/, 'the opt-out');
  assert.match(panel, /okToSpend\(image, 1\)/, 'asked about only after a few takes');
  assert.match(panel, /can\.reason/, 'the disabled button explains itself');

  const controls = src('components/HeroImageControls.tsx');
  assert.match(controls, /<ImageEditPanel/, 'the Calendar preview and RunPreview');
  assert.match(controls, /fetch\('\/api\/drafts\/image\?id='/, 'pre-filled from the draft');
  assert.match(controls, /credits: 1/, 'New AI image is labelled as a credit');
  assert.ok(controls.indexOf('Choose from Image Library') < controls.indexOf("send({ regenerate: true, fresh: true }"), 'free actions first');
  assert.ok(controls.indexOf('<ImageEditPanel') < controls.indexOf("send({ regenerate: true, fresh: true }"), 'the panel before the credit button');

  const queue = src('app/AutopilotQueue.tsx');
  assert.match(queue, /<ImageEditPanel/, 'the Dashboard card');
  assert.match(queue, /'↻ New image ' \+ creditLabel\(1\)/);
  assert.match(queue, /'⁝⁝ Show me 3 options ' \+ creditLabel\(3\)/);
  assert.match(queue, /okToSpend\(r\.pack\?\._image, count\)/, 'three options ask on a much-rerolled draft');
  assert.ok(queue.indexOf('<ImageEditPanel') < queue.indexOf("'↻ New image '"), 'the panel before the credit buttons');
});

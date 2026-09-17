// web/lib/post-title.test.ts
//
// THE TITLE THAT WENT OUT. The composer sent the media label as the post's
// title, so YouTube and TikTok were handed, verbatim:
//
//   Video_RyallxCellgenicxCellularInstitute_Rodrigo.mp4
//
// Two staff names, a partner's name, a container word and a file extension, on
// a clinic's public channel. lib/video-title.ts cleans a filename that CONTAINS
// its subject; this one does not contain one, and cleaning it produces
// "Ryallx Cellgenicx Cellular Institute at Cellular Institute" — worse than
// what it replaced.
//
// The answer was already in the pipeline: every prepared row runs a keyword
// search, reseeded from the transcript when the filename turns out to say
// nothing (lib/reseed.ts). It knows this video is about red light therapy. The
// title comes from that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { looksInternal, professionalTitle, withClinic } from './post-title.ts';
import { titleCasePhrase, cleanVideoTitle } from './video-title.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NO_ENV: Record<string, string | undefined> = {};

test('the file that started this never reaches a title again', () => {
  const filename = 'Video_RyallxCellgenicxCellularInstitute_Rodrigo.mp4';
  // What it used to produce, and why cleaning alone was not the fix.
  assert.match(cleanVideoTitle(filename, { env: NO_ENV }), /Cellular Institute at Cellular Institute/);

  const out = professionalTitle({ supplied: filename, keyword: 'red light therapy', filename, env: NO_ENV });
  assert.equal(out.title, 'Red Light Therapy at Cellular Institute');
  assert.equal(out.source, 'keyword');
});

test('an editor’s name glued to the next word is still an editor’s name', () => {
  // "Ryallx" is why this matches on substring rather than whole word: the whole
  // -word rule in lib/video-title.ts left it in, and it was published.
  assert.equal(looksInternal('Ryallx Cellgenic', NO_ENV), true);
  assert.equal(looksInternal('Reel_RedLight_Rodrigo.mp4', NO_ENV), true);
  assert.equal(looksInternal('Red Light Therapy', NO_ENV), false);
  assert.equal(looksInternal('', NO_ENV), true, 'nothing is not a title');
  // Short entries stay whole-word, or "IV" would strike out "arrival".
  assert.equal(looksInternal('Arrival day at the clinic', { VIDEO_TITLE_STRIP: 'iv' }), false);
  assert.equal(looksInternal('IV therapy day', { VIDEO_TITLE_STRIP: 'iv' }), true);
});

test('a title somebody wrote is kept in their words', () => {
  const out = professionalTitle({ supplied: 'Nuestro protocolo de oxígeno', keyword: 'hbot cancun', env: NO_ENV });
  assert.equal(out.title, 'Nuestro protocolo de oxígeno at Cellular Institute');
  assert.equal(out.source, 'written', 'the keyword does not overrule a person');
});

test('the clinic’s name is added once, never twice', () => {
  assert.equal(withClinic('Red Light Therapy'), 'Red Light Therapy at Cellular Institute');
  assert.equal(withClinic('Inside Cellular Institute'), 'Inside Cellular Institute');
  assert.equal(withClinic(''), 'Cellular Institute');
  assert.equal(withClinic('Red Light', ''), 'Red Light');
});

test('a searcher’s phrase is set like a title, not like a sentence', () => {
  assert.equal(titleCasePhrase('stem cell therapy for knees'), 'Stem Cell Therapy for Knees');
  assert.equal(titleCasePhrase('hbot cancun'), 'HBOT Cancun');
  assert.equal(titleCasePhrase('prp and exosomes'), 'PRP and Exosomes');
  assert.equal(titleCasePhrase(''), '');
});

test('the order is: a person, the research, the speaker, the file, the clinic', () => {
  const env = NO_ENV;
  assert.equal(professionalTitle({ supplied: 'Written Title', keyword: 'kw', spoken: 'sp', filename: 'f.mp4', env }).source, 'written');
  assert.equal(professionalTitle({ keyword: 'red light therapy', spoken: 'sp', filename: 'f.mp4', env }).source, 'keyword');
  assert.equal(professionalTitle({ spoken: 'vagus nerve reset', filename: 'Reel_Rodrigo.mp4', env }).source, 'spoken');
  assert.equal(professionalTitle({ filename: 'Reel_RedLightRyall_Rodrigo.mp4', env }).source, 'filename');
  // Nothing usable anywhere: the clinic's name alone is plain, and is never
  // wrong — unlike publishing the name of whoever held the camera.
  const nothing = professionalTitle({ filename: 'Reel_Rodrigo.mp4', env });
  assert.equal(nothing.title, 'Cellular Institute');
  assert.equal(nothing.source, 'clinic');
});

test('a keyword that is itself internal is refused, not published', () => {
  // Semrush has returned a partner's brand name as a "keyword" before. A title
  // is the one place that must never carry one.
  const out = professionalTitle({ keyword: 'ryall clinic', filename: 'Reel_HBOTSession.mp4', env: NO_ENV });
  assert.equal(out.source, 'filename');
  assert.equal(out.title, 'HBOT Session at Cellular Institute');
});

test('nothing absurdly long becomes a title', () => {
  const long = 'a'.repeat(200);
  assert.equal(professionalTitle({ supplied: long, env: NO_ENV }).source, 'clinic');
});

// --- IT IS ACTUALLY USED ----------------------------------------------------

test('preparing a row titles it from the research it just ran', () => {
  const prepare = src('lib/video-prepare.ts');
  assert.match(prepare, /professionalTitle\(\{/, 'prepareVideo must build the public title');
  assert.match(prepare, /keyword: brief\.stamp\.primary/, 'from the keyword search, which is the point');
  assert.match(prepare, /title: publicTitle/, 'and the pack must carry it');
  assert.match(prepare, /saveVideoDraft\(input\.userId, publicTitle/, 'and so must the saved draft');
});

test('the composer sends the title a person can see, not the filename', () => {
  const page = src('app/page.tsx');
  assert.ok(!/title: mMediaLabel/.test(page), 'the media label is the FILENAME — it must never be the post title again');
  assert.match(page, /title: mTitle\.trim\(\) \|\| undefined/, 'the title box is what goes to Metricool');
  assert.match(page, /id="composer-title"/, 'and it has to be visible above the copy');
  assert.match(page, /\/api\/keywords\?topic=/, 'with the keyword search reachable from there');
});

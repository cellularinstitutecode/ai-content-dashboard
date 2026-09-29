// web/lib/library-cover.test.ts
// "Use library photo with brand filter": the grade decision, the headroom
// under the title, the title itself, the verdict read for a photograph, the
// provenance — and where the button is wired. When the ffmpeg binary is
// present the filter graph is run on a real picture too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BRAND_TARGET, GRADE_LIMITS, gradeFor } from './palette.ts';
import {
  COVER_HEAD_CLEAR_PCT, COVER_MIN_HEAD_TOP_PCT, MAX_COVER_TITLE_CHARS, MAX_PAD_FRACTION,
  cappedStats, coverTitleFor, ffmpegCoverArgs, gradeDecision, headTopAfterPad, headroomPad, libraryProvenance, needsFfmpeg, photographVerdict,
} from './library-cover.ts';
import { classifyVerdict } from './image-verdict.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// --- THE GRADE ----------------------------------------------------------------

test('a photo in the palette is left alone; one near it gets the measured filters', () => {
  const ready = gradeDecision(BRAND_TARGET);
  assert.equal(ready.verdict, 'ready');
  assert.deepEqual(ready.filters, []);
  assert.equal(ready.note, null);
  // Ordinary fluorescent clinic light: cool and a little dark.
  const cool = { r: 140, g: 150, b: 160, warm: -10, sat: 20, lum: 130 };
  const g = gradeDecision(cool);
  assert.equal(g.verdict, 'grade');
  assert.deepEqual(g.filters, gradeFor(cool).filters, 'the filters we already have, unchanged');
  assert.equal(g.filters.length, 2);
  assert.match(g.filters[0], /^colorbalance=/);
  assert.match(g.filters[1], /^eq=contrast=/);
});

test('a photo outside the palette still gets the filter, at its limit, and the note says so', () => {
  // The magenta LED room: far too saturated and too cold for an honest grade.
  const led = { r: 120, g: 60, b: 150, warm: -30, sat: 70, lum: 90 };
  assert.equal(gradeFor(led).verdict, 'outside');
  assert.deepEqual(gradeFor(led).filters, [], 'the triage refuses it');
  const g = gradeDecision(led);
  assert.equal(g.verdict, 'outside');
  assert.equal(g.filters.length, 2, 'but the hero still gets a capped filter');
  assert.match(String(g.note), /outside the brand palette/);
  assert.match(String(g.note), /at its limit/);
  // The capped stats sit exactly at the limits on the measures that overshoot
  // (too saturated, too dark) and stay put on the one that does not (the cast).
  const c = cappedStats(led);
  assert.equal(c.sat, BRAND_TARGET.sat + GRADE_LIMITS.sat);
  assert.equal(c.lum, BRAND_TARGET.lum - GRADE_LIMITS.lum);
  assert.equal(c.warm, led.warm);
  assert.equal(gradeFor(c).verdict, 'grade', 'and a grade at the limits is an honest grade');
  // A measure inside its limit is not moved.
  const onlyCold = { ...BRAND_TARGET, warm: -60 };
  assert.equal(cappedStats(onlyCold).sat, BRAND_TARGET.sat);
  assert.equal(cappedStats(onlyCold).warm, BRAND_TARGET.warm - GRADE_LIMITS.warm);
});

test('a photo ffmpeg could not read is used without the filter, and the note says so', () => {
  const g = gradeDecision(null);
  assert.equal(g.verdict, 'unmeasured');
  assert.deepEqual(g.filters, []);
  assert.match(String(g.note), /could not be measured/);
  assert.equal(needsFfmpeg(g, 0), false);
  assert.equal(needsFfmpeg(g, 0.2), true, 'the pad alone is a reason to run it');
});

// --- HEADROOM UNDER THE TITLE ------------------------------------------------

test('a head clear of the title band needs no sky; one under it gets exactly enough', () => {
  assert.equal(headroomPad(null), 0);
  assert.equal(headroomPad(undefined), 0);
  assert.equal(headroomPad(Number.NaN), 0);
  assert.equal(headroomPad(COVER_MIN_HEAD_TOP_PCT), 0);
  assert.equal(headroomPad(55), 0);
  // A head at 12%: pad until it lands at COVER_HEAD_CLEAR_PCT.
  const pad = headroomPad(12);
  assert.ok(pad > 0 && pad < MAX_PAD_FRACTION, String(pad));
  assert.equal(Math.round(headTopAfterPad(12, pad)), COVER_HEAD_CLEAR_PCT);
  assert.ok(headTopAfterPad(12, pad) >= COVER_MIN_HEAD_TOP_PCT, 'the existing verifier passes on the padded photo');
  // A head right at the top edge is too much filler: the flag stands instead.
  assert.equal(headroomPad(0), 0, 'more than MAX_PAD_FRACTION is refused');
  assert.equal(headroomPad(8) > 0, true);
});

test('the filter graph pads above the photo with a blurred mirror of its top edge, then grades', () => {
  const plain = ffmpegCoverArgs('/in.jpg', '/out.jpg', { filters: ['colorbalance=rm=0.050:gm=0:bm=-0.050'], pad: 0 });
  const graph = plain[plain.indexOf('-filter_complex') + 1];
  assert.match(graph, /^\[0:v\]colorbalance=rm=0\.050:gm=0:bm=-0\.050,scale=/);
  assert.doesNotMatch(graph, /vstack/);
  assert.ok(plain.includes('-nostdin') && plain.includes('-y') && plain.includes('mjpeg'));
  assert.equal(plain[plain.length - 1], '/out.jpg');
  const padded = ffmpegCoverArgs('/in.jpg', '/out.jpg', { filters: [], pad: 0.24 });
  const g2 = padded[padded.indexOf('-filter_complex') + 1];
  assert.match(g2, /split=2\[base\]\[strip\]/);
  assert.match(g2, /crop=iw:max\(2\\,ih\*0\.12\):0:0,vflip,scale=iw:ih\*2\.000:flags=lanczos,gblur/, 'the strip is scaled to the pad height');
  assert.match(g2, /\[top\]\[base\]vstack=inputs=2,scale=/, 'sky on top, then the fit');
  assert.match(g2, /\[strip\]crop=/, 'only the mirrored strip is cropped');
  assert.doesNotMatch(g2, /\[base\]crop=/, 'nothing of the photo is cropped away');
});

test('with the binary present, the padded graph really adds the sky', async (t) => {
  let bin = '';
  try {
    const mod = await import('ffmpeg-static');
    bin = String((mod as { default?: unknown }).default || '');
    accessSync(bin, constants.X_OK);
  } catch {
    t.skip('ffmpeg binary not available here');
    return;
  }
  const run = promisify(execFile);
  const dir = mkdtempSync(path.join(tmpdir(), 'chi-cover-test-'));
  try {
    const input = path.join(dir, 'in.jpg');
    const output = path.join(dir, 'out.jpg');
    await run(bin, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=600x400:rate=1', '-frames:v', '1', input]);
    const pad = headroomPad(12);
    await run(bin, ffmpegCoverArgs(input, output, { filters: gradeFor({ r: 140, g: 150, b: 160, warm: -10, sat: 20, lum: 130 }).filters, pad }), { timeout: 60_000 });
    const { stdout } = await run(bin, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'gray', '-vf', 'scale=1:ih', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
    // One grey pixel per row: the height of the result is the number of rows.
    const rows = (stdout as unknown as Buffer).length;
    assert.equal(rows, Math.round(400 * (1 + pad)), 'height grew by the pad');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- THE TITLE ----------------------------------------------------------------

test('the title is the planner\'s own, else the topic kept short', () => {
  const planner = { _autopilot: { template_name: 'Nutrition', pillar_id: 'nutrition', angle: { query: 'protein and recovery' } } };
  const t = coverTitleFor(planner, '[Autopilot] protein and recovery');
  assert.ok(t.length > 0 && t.length <= MAX_COVER_TITLE_CHARS, t);
  assert.doesNotMatch(t, /autopilot/i);
  assert.equal(coverTitleFor({}, '[Autopilot] Sleep and Recovery'), 'Sleep and Recovery');
  const long = coverTitleFor({}, 'A very long topic line about recovery, mobility and the years a person keeps moving well, easily');
  assert.ok(long.length <= MAX_COVER_TITLE_CHARS, long);
  assert.doesNotMatch(long, /[,\s]$/, 'cut at a word, no trailing comma');
});

// --- THE VERDICT, READ FOR A PHOTOGRAPH ----------------------------------------

test('on a real photograph, signage and props are notes; a head under the title and the wrong subject still flag', () => {
  const raw = { approved: false, textDetected: true, bannedProp: true, onTopic: false, headTopPct: 10, score: 70, blocking: ['sign on the wall', 'a pill bottle'], advisory: ['bright'] };
  const measured = classifyVerdict(raw, { requireOnTopic: true, minHeadTopPct: COVER_MIN_HEAD_TOP_PCT });
  assert.equal(measured.status, 'flagged');
  const v = photographVerdict(measured);
  assert.equal(v.status, 'flagged');
  assert.equal(v.textDetected, false, 'a real sign is not model gibberish');
  assert.equal(v.bannedProp, false);
  assert.ok(v.issues.some((i) => /head reaches into the title area/.test(i)));
  assert.ok(v.issues.some((i) => /off-topic/.test(i)));
  assert.ok(v.issues.every((i) => /head reaches|off-topic/.test(i)), v.issues.join(' | '));
  assert.ok(v.advisory.some((i) => /sign on the wall/.test(i)) && v.advisory.some((i) => /bright/.test(i)));
  assert.equal(v.headTopPct, 10);
  // Clean headroom, no planner: approved whatever the model said about text.
  const clean = photographVerdict(classifyVerdict({ approved: false, textDetected: true, headTopPct: 48, blocking: ['lettering on a mug'] }, { minHeadTopPct: COVER_MIN_HEAD_TOP_PCT }));
  assert.equal(clean.status, 'approved');
  assert.deepEqual(clean.issues, []);
});

// --- PROVENANCE -----------------------------------------------------------------

test('the picture records where it came from and what was done to it', () => {
  const graded = libraryProvenance({ decision: { verdict: 'grade', filters: ['a', 'b'] }, applied: true, pad: 0.2, libraryFileId: '1abcDEF_xyz', libraryName: 'reception.jpg' });
  assert.deepEqual(graded, { source: 'library', brandGraded: true, filters: ['a', 'b'], palette: 'grade', padded: 0.2, libraryFileId: '1abcDEF_xyz', libraryName: 'reception.jpg' });
  // Already in the palette: graded in the sense that it needed nothing.
  assert.deepEqual(libraryProvenance({ decision: { verdict: 'ready', filters: [] }, applied: false }), { source: 'library', brandGraded: true, filters: [], palette: 'ready' });
  // ffmpeg missing: the photo went in as it was, and the record says so.
  const raw = libraryProvenance({ decision: { verdict: 'grade', filters: ['a'] }, applied: false, pad: 0.2 });
  assert.equal(raw.brandGraded, false);
  assert.deepEqual(raw.filters, []);
  assert.equal('padded' in raw, false);
});

// --- WHERE IT IS WIRED ----------------------------------------------------------

test('the button uses the library photo itself; the AI-description path is gone', () => {
  const controls = src('components/HeroImageControls.tsx');
  assert.match(controls, /Use library photo with brand filter/);
  assert.match(controls, /Click a photo\. It gets the brand\\'s colour filter and the post title — no AI\./);
  assert.match(controls, /brandPhotoUrl: url, alt: img\.name, libraryFileId: img\.id/);
  assert.doesNotMatch(controls, /styled after|styleFromUrl/i);

  const route = src('app/api/drafts/image/route.ts');
  assert.match(route, /const brandPhotoUrl = typeof body\?\.brandPhotoUrl === 'string'/);
  assert.match(route, /await libraryHero\(\{ url: brandPhotoUrl, title: true,/, 'the photo, graded and titled');
  assert.match(route, /await libraryHero\(\{ url, title: false,/, '"Choose from Image Library" is graded too, with no title');
  assert.doesNotMatch(route, /styleFromUrl|describeReferencePhoto|styleDirection/);
  assert.doesNotMatch(src('lib/images.ts'), /describeReferencePhoto|image-reference/);

  const hero = src('lib/library-hero.ts');
  assert.match(hero, /gradeDecision\(await measureImage\(input\)\)/, 'measured with the palette tool');
  assert.match(hero, /verifyLibraryPhoto\(/, 'checked by the same reviewer as a cover');
  assert.match(hero, /pad = headroomPad\(verification\.headTopPct\)/);
  assert.match(hero, /renderTitleCover\(\{ title, photo: \{ bytes, contentType \}, headTopPct: verification\?\.headTopPct \?\? null \}\)/, 'the title placed by the same rule');
  assert.doesNotMatch(hero, /generatePackImage|images\/generations/, 'no image model');

  const images = src('lib/images.ts');
  assert.match(images, /\{ headroom: true, photograph: true \}/, 'the reviewer is asked for the headroom, and reads the photo as a photograph');
  assert.match(images, /const verdict = mode\.photograph \? photographVerdict\(measured\) : measured;/);
});

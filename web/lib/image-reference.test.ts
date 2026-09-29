// web/lib/image-reference.test.ts
// A library photo as a style reference: described, then written into the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_DESCRIPTION_CHARS, parseReferenceDescription, styleDirection } from './image-reference.ts';

test('the vision model’s JSON is read, and plain prose is accepted too', () => {
  assert.equal(parseReferenceDescription('{"style":"Soft window light,  cream and walnut."}'), 'Soft window light, cream and walnut.');
  assert.equal(parseReferenceDescription('Warm afternoon light on pale stone.'), 'Warm afternoon light on pale stone.');
  assert.equal(parseReferenceDescription(''), null);
  assert.equal(parseReferenceDescription('{"style": ""}'), null);
  assert.equal(parseReferenceDescription(null), null);
});

test('a runaway description is cut at a word, so it cannot take over the prompt', () => {
  const long = Array.from({ length: 200 }, (_, i) => 'word' + i).join(' ');
  const out = parseReferenceDescription(long) as string;
  assert.ok(out.length <= MAX_DESCRIPTION_CHARS);
  assert.doesNotMatch(out, /\s$/);
  assert.match(out, /word\d+$/, 'ends on a whole word');
});

test('the direction borrows the look and leaves the subject to the post', () => {
  const d = styleDirection('Soft window light, cream and walnut.');
  assert.match(d, /^Match the style of this reference photograph/);
  assert.match(d, /compose a new scene for the subject/);
  assert.match(d, /Soft window light, cream and walnut\.$/);
  assert.equal(styleDirection('X', '  more plants '), styleDirection('X') + ' Also: more plants');
});

test('the describer is told to skip people, text and the subject', () => {
  const src = readFileSync(new URL('./image-reference.ts', import.meta.url), 'utf8');
  assert.match(src, /do NOT name people/);
  assert.match(src, /do NOT transcribe any text/);
  assert.match(src, /do NOT dictate the subject/);
});

// --- THE ROUTE USES IT ------------------------------------------------------

test('a styled take is a fresh generation that still goes through verification', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/drafts/image/route.ts');
  assert.match(route, /const styleFromUrl = typeof body\?\.styleFromUrl === 'string'/);
  assert.match(route, /const regenerate = body\?\.regenerate === true \|\| Boolean\(styleFromUrl\);/, 'never the cached hero');
  assert.match(route, /describeReferencePhoto\(styleFromUrl\)/, 'the photo is read by the vision model');
  assert.match(route, /styleDirection\(/, 'and its style becomes the direction');
  // The description is computed AFTER the rate limit and BEFORE generation.
  const rl = route.indexOf("checkRateLimit(user.id, 'image')");
  const describe = route.indexOf('describeReferencePhoto(styleFromUrl)');
  const make = route.indexOf('const makeOne =');
  assert.ok(rl > -1 && rl < describe && describe < make);

  const images = src('lib/images.ts');
  assert.match(images, /export async function describeReferencePhoto/);
  assert.match(images, /REFERENCE_DESCRIBE_SYSTEM/);
  assert.match(images, /parseReferenceDescription\(/);
});

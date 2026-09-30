import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePictureBrief, pictureBriefSystemPrompt, topicFromPicture } from './picture-brief.ts';

test('parsePictureBrief: the model’s JSON, fenced or not, defensively', () => {
  const b = parsePictureBrief('```json\n{"description":"A woman stretching on a terrace at sunrise.","idea":"Morning movement after treatment","caution":""}\n```');
  assert.deepEqual(b, { description: 'A woman stretching on a terrace at sunrise.', idea: 'Morning movement after treatment', caution: '' });
  assert.equal(parsePictureBrief('not json'), null);
  assert.equal(parsePictureBrief({}), null);
  assert.equal(parsePictureBrief({ description: 'A bowl of fruit.' })?.idea, 'A bowl of fruit.', 'no idea: the description stands in');
  assert.equal(parsePictureBrief({ description: 'x'.repeat(700) })?.description.length, 600);
});

test('topicFromPicture: what was typed leads, the photograph follows, and the copy is held to it', () => {
  const brief = { description: 'An IV suite with two empty chairs and sea light.', idea: 'What to expect in the recovery lounge', caution: 'No treatment is being given.' };
  const t = topicFromPicture('', brief);
  assert.ok(t.startsWith('What to expect in the recovery lounge\n'));
  assert.match(t, /The photograph shows: An IV suite/);
  assert.match(t, /do not describe anything that is not in it/);
  assert.match(t, /About the photograph: No treatment is being given\./);
  assert.ok(topicFromPicture('  3 captions about rest days  ', brief).startsWith('3 captions about rest days\n'), 'typed idea first');
  assert.ok(topicFromPicture('', { ...brief, description: 'y'.repeat(3000) }).length <= 2000);
});

test('the prompt asks for the three keys and forbids promotion and cures', () => {
  const p = pictureBriefSystemPrompt();
  for (const k of ['"description"', '"idea"', '"caution"']) assert.ok(p.includes(k));
  assert.match(p, /Never a promotion, never a claim of a cure/);
});

test('the idea box takes a picture: read by the vision model, written through the same pipeline, and made the post’s picture', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/generate/see/route.ts');
  assert.match(route, /decodeDataUrl\(/, 'the same decoder the drop box uses');
  assert.match(route, /checkRateLimit\(user\.id, 'generate'\)/, 'on the writing allowance');
  assert.match(route, /isAllowedEmail\(user\.email\)/);
  assert.match(route, /detail: 'low'/, 'a small read, like the library indexer');
  assert.match(route, /parsePictureBrief\(/);
  const page = src('app/page.tsx');
  assert.match(page, /id="gen-idea-image"[^>]*accept="image\/\*"/, 'the + takes a picture');
  assert.match(page, /onDrop=\{onIdeaDrop\}/, 'and so does dropping one on the idea box');
  assert.match(page, /topicFromPicture\(prompt, ideaImage\.brief\)/, 'the picture is the topic');
  assert.match(page, /dataUrl: ideaImage\.dataUrl, alt: ideaImage\.brief\.description/, 'the dropped picture becomes the post’s picture');
  assert.match(page, /disabled=\{loading \|\| \(!prompt\.trim\(\) && !ideaImage\)\}/, 'Generate works from the picture alone');
});

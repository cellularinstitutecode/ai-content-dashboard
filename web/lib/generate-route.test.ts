// web/lib/generate-route.test.ts
// The Content Generator: time to write, and a reason when it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the generate route runs at the 300s ceiling, budgets the writer, and says why a post was not written', () => {
  const route = readFileSync(new URL('../app/api/generate/route.ts', import.meta.url), 'utf8');
  assert.match(route, /export const maxDuration = 300;/, 'not the one door with a sixty-second clock');
  assert.match(route, /budgetMs: 200_000,/);
  assert.match(route, /if \(e instanceof NoKeywordsError\) \{[\s\S]{0,300}status: 422/);
  assert.match(route, /'The post could not be written: ' \+ writerFailure\(e\) \+ '\.'/);
  assert.doesNotMatch(route, /error: 'Generation failed\. Please try again\.'/, 'the generic line is gone');
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /r\.status === 504 \|\| r\.status === 502[\s\S]{0,120}cut off/, 'a gateway timeout is said as one, not as a number');
});

test('the Content Generator: no separate Keyword research button, the picture from the library first, the same image editor as every draft', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /🔑 Keyword research\n<\/a>/, 'the button is gone; the research is the first step of Generate');
  // A picture dropped on the idea box is the post's picture; otherwise the library first.
  assert.match(page, /ideaImages\.length \? \{ id: draftId, dataUrl: ideaImages\[0\]\.dataUrl, alt: ideaImages\[0\]\.brief\.description \} : \{ id: draftId, auto: true \}/, 'library first, unless pictures were dropped — then the first of them');
  assert.match(page, /<HeroImageControls\n\s+key=\{lastDraftId\}\n\s+draftId=\{lastDraftId\}/, 'the drafts’ own controls and editor');
  assert.match(page, /only=\{\['upload'\]\}/, 'the picker keeps only the file drop');
  const route = readFileSync(new URL('../app/api/drafts/image/route.ts', import.meta.url), 'utf8');
  assert.match(route, /if \(body\?\.auto === true\) \{\s*const picked = await pictureForDraft\(id, user\.id, \{ quality: 'high' \}\);/);
  const picker = readFileSync(new URL('../components/HeroImagePicker.tsx', import.meta.url), 'utf8');
  assert.match(picker, /\{!loading && loaded && !images\.length && /, '"no photographs" only after the folder was read');
});

test('the library is asked for a photograph of the clinic before anything is generated, and says why when it declines', () => {
  const pick = readFileSync(new URL('./library-pick.ts', import.meta.url), 'utf8');
  assert.match(pick, /const pillars = \[\.\.\.own, \.\.\.GENERAL_PILLARS\]/, 'the post’s pillar first, then the clinic’s rooms');
  assert.match(pick, /const TOP_UP = 6;/);
  assert.match(pick, /why\(rows\.length \+ ' photograph'/);
  const topic = readFileSync(new URL('./library-topic.ts', import.meta.url), 'utf8');
  assert.match(topic, /const fit = !g \? 0\.6 :/, 'an unmeasured photograph is ranked, not refused');
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /From the clinic\\'s own library/);
  assert.match(page, /An AI picture was made instead; pick a library photo above to replace it\./);
});

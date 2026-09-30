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

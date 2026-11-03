// web/lib/cover-redo-wiring.test.ts
// "Redo old covers": the route redoes through the same retitle Apply title
// uses, stamps the record, and the studio draws the card. Source checks: the
// route and the component cannot be loaded by the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the route lists old covers by the tested rule, redoes each with retitleImage, stamps it, and names the posts to sync', () => {
  const route = src('app/api/drafts/covers/route.ts');
  assert.match(route, /isOldCover\(/);
  assert.match(route, /await retitleImage\(existing, title, d\.topic \|\| 'cover'\)/);
  assert.match(route, /coverRedone: true/);
  assert.match(route, /withoutHeadFlag\(made\.verification\)/);
  // A draft with a published post is not redone at all; a published post is never touched.
  assert.match(route, /return unpublishedOnly\(old, /);
  assert.match(route, /p\.status !== 'published'/);
  // The user's own drafts only.
  assert.match(route, /\.eq\('user_id', userId\)/);
});

test('the studio draws the card, which syncs the posts through the posts route’s sync_media', () => {
  assert.match(src('app/ImageStudio.tsx'), /<RedoCovers onDone=/);
  const c = src('components/RedoCovers.tsx');
  assert.match(c, /fetch\('\/api\/drafts\/covers', \{ method: 'POST'/);
  assert.match(c, /fetch\('\/api\/posts', \{ method: 'PATCH'[^\n]*action: 'sync_media'/);
});

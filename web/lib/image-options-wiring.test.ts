// web/lib/image-options-wiring.test.ts
//
// "Show me 3 options" came back in zero seconds with nothing new.
//
// The set request carried `options: 3`, but the handler's cache short-circuit
// only knew about `regenerate` and `option`, so a draft that already had a hero
// — which is every draft the button appears on — returned that hero untouched
// and the whole feature was a no-op. It passed every unit test, because the
// route talks to Supabase and OpenAI and cannot be loaded by the test runner.
// These are source checks on the wiring itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../app/api/drafts/image/route.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../app/AutopilotQueue.tsx', import.meta.url), 'utf8');

test('a set of propositions bypasses the cached-image short-circuit', () => {
  const guard = route.match(/if \(existing\?\.url &&[^)]*\)/)?.[0] ?? '';
  assert.ok(guard, 'the cached-image guard should still exist');
  assert.match(guard, /!wantSet/, 'a set must not return the cached hero');
});

test('a set advances the variant, so the three takes are not the same picture', () => {
  const line = route.match(/const advanceVariant = .*/)?.[0] ?? '';
  assert.match(line, /wantSet/);
});

test('the three takes are generated in parallel, not one after another', () => {
  assert.match(route, /Promise\.allSettled\(Array\.from\(\{ length: wantSet \}/);
});

test('propositions never overwrite the hero', () => {
  assert.match(route, /const nextHero = proposing \? \(priorImage \?\? image\) : image;/);
  assert.match(route, /_image: nextHero/);
});

test('the queue asks for the whole set in one request', () => {
  const fn = queue.slice(queue.indexOf('async function proposeImages'), queue.indexOf('/** Promote one proposition'));
  assert.match(fn, /options: count/);
  assert.doesNotMatch(fn, /for \(let i = 0; i < count; i\+\+\)/, 'the sequential loop should be gone');
});

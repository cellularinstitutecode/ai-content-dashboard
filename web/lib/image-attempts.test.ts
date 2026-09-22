// web/lib/image-attempts.test.ts
//
// "Can you put a newer model in the image generator?"
//
// The model was already a setting — OPENAI_IMAGE_MODEL — so the answer to that
// question is one environment variable and no deploy. What was NOT right was
// everything around it: the images were generated at medium quality inside a
// sixty-second function that allowed four fifty-second attempts, so a slow
// first attempt was killed by the platform and the rungs below it never ran.
//
// These are source checks: lib/images.ts talks to OpenAI and cannot be loaded
// by the test runner, which is exactly why the arithmetic in it went unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the model is a setting, not a constant', () => {
  const images = src('lib/images.ts');
  assert.match(images, /process\.env\.OPENAI_IMAGE_MODEL \|\| 'gpt-image-1'/, 'a newer model needs no deploy');
  assert.match(images, /process\.env\.OPENAI_IMAGE_FALLBACK_MODEL/, 'and a name that does not exist still makes an image');
  // Said where somebody configuring this will read it.
  assert.match(src('.env.example'), /A NEWER MODEL NEEDS NO DEPLOY/);
});

test('quality leads at high, and steps down rather than failing', () => {
  // "The photos look too AI" is answered most directly by quality: at medium
  // the model spends less on hands, skin and the way light falls on a real
  // surface — which is what a clinical photograph is judged on.
  const images = src('lib/images.ts');
  const chain = images.slice(images.indexOf('async function generateImageBytes'), images.indexOf('const errors: string[] = []'));
  const high = chain.indexOf("quality: 'high'");
  const medium = chain.indexOf("quality: 'medium'");
  assert.ok(high > 0, 'the first attempt asks for high');
  assert.ok(medium > high, 'and medium is the rung below it, not the first choice');
  // The rung with no quality at all survives a model that renamed the values.
  assert.ok(chain.indexOf('output_compression: 80 } }') > medium, 'then no quality parameter at all');
});

test('the route outlives the attempts it is allowed to make', () => {
  // The same bug the schedule route had: four 50-second attempts, plus a vision
  // check, inside a 60-second function. A slow first attempt was killed by the
  // platform with a bodyless 504 and nothing below it ever ran — and `high` is
  // slower, which would have made that the ordinary case rather than the rare one.
  const route = src('app/api/drafts/image/route.ts');
  const declared = Number(/export const maxDuration = (\d+)/.exec(route)?.[1] || 0);
  // The default per-call timeout, and the longer one weekly-planner covers get
  // (portrait, high quality, a long prompt). The route must outlive two of the longest.
  const images = src('lib/images.ts');
  const byDefault = Number(/callMs = (\d+)_000\)/.exec(images)?.[1] || 0);
  const planner = Number(/PLANNER_IMAGE_CALL_MS = (\d+)_000;/.exec(images)?.[1] || 0);
  const perAttempt = Math.max(byDefault, planner);
  assert.match(images, /callImagesApi\(attempts\[i\]\.body, callMs\)/, 'every rung uses the per-call timeout');
  assert.ok(perAttempt > 0, 'the per-attempt timeout must be readable');
  assert.ok(
    declared >= perAttempt * 2,
    'the route allows ' + declared + 's for attempts of ' + perAttempt + 's each',
  );
});

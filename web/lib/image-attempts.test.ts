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
  const byDefault = Number(/const IMAGE_CALL_MS = (\d+)_000;/.exec(images)?.[1] || 0);
  const planner = Number(/PLANNER_IMAGE_CALL_MS = (\d+)_000;/.exec(images)?.[1] || 0);
  const perAttempt = Math.max(byDefault, planner);
  assert.match(images, /callImagesApi\(attempts\[i\]\.body, rungMs\(\)\)/, 'every rung uses the per-call timeout, cut to what is left of the deadline');
  assert.ok(perAttempt > 0, 'the per-attempt timeout must be readable');
  assert.ok(
    declared >= perAttempt * 2,
    'the route allows ' + declared + 's for attempts of ' + perAttempt + 's each',
  );
});

test('a high-quality picture gets the time it takes, and a timeout steps down instead of failing', () => {
  // A week of strategy previews came back "[gpt-image-1#1] This operation was
  // aborted": every draft's Images call had 50s, gpt-image-1 at high takes
  // 40-100s, and a timeout never fell through to the medium rung below.
  const images = src('lib/images.ts');
  assert.match(images, /const IMAGE_CALL_MS = 110_000;/, 'the same 110s planner covers get');
  assert.match(images, /const usual = planner \? PLANNER_IMAGE_CALL_MS : IMAGE_CALL_MS;/);
  assert.match(images, /const ATTEMPT_MS = 120_000;/, 'a retry is sized for a call that long');
  // The timeout is our own timer, and is said as such.
  assert.match(images, /if \(controller\.signal\.aborted\) \{\s*const err = new Error\('no picture within ' \+ Math\.round\(timeoutMs \/ 1000\) \+ 's'\);/);
  assert.match(images, /\.timedOut = true;/);
  // After a timeout the next rung runs when there is time for it — and never when there is not.
  assert.match(images, /const timeForAnother = deadline == null \|\| deadline - Date\.now\(\) >= FALLBACK_AFTER_TIMEOUT_MIN_MS;/);
  assert.match(images, /if \(isLast \|\| !\(rejected \|\| \(timedOut && timeForAnother\)\)\)/);
  assert.match(images, /generateImageBytes\(prompt, planner\?\.size, callMs\(\), deadline, /, 'the deadline travels down to the ladder');
  // Every route that makes a picture outlives a high call, a medium fallback and the check.
  for (const route of ['app/api/templates/strategy-upload/route.ts', 'app/api/drafts/image/route.ts', 'app/api/posts/route.ts', 'app/api/assistant/route.ts', 'app/api/autopilot/tick/route.ts']) {
    const declared = Number(/export const maxDuration = (\d+)/.exec(src(route))?.[1] || 0);
    assert.ok(declared >= 300, route + ' allows ' + declared + 's');
  }
});

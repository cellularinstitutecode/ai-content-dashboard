// Health must report CAPABILITY, not configuration — for every provider.
//
// The defect these tests pin: lib/provider-status.ts began hardcoded to
// `openai_images`, so the correction its own header describes ("`has(KEY)`
// answers 'is this configured', and nobody was asking that") was only ever
// applied to images. A revoked ANTHROPIC_API_KEY or a rotated Metricool token
// reported healthy forever while every draft and every schedule failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyImageFailure } from './image-failure-reason.ts';
import { plainFor } from './health-plain.ts';

const readSrc = (p: string) => readFileSync(new URL('./' + p, import.meta.url), 'utf8');

// --- the classifier is genuinely provider-agnostic ---------------------------

test('real Anthropic and Metricool refusals classify correctly', () => {
  assert.equal(classifyImageFailure('anthropic 401: {"error":{"message":"invalid x-api-key"}}'), 'bad_key');
  assert.equal(classifyImageFailure('anthropic 429: {"type":"rate_limit_error"}'), 'rate_limited');
  assert.equal(classifyImageFailure('Metricool 401: {"message":"unauthorized"}'), 'bad_key');
  assert.equal(classifyImageFailure('anthropic 400: credit_balance_exhausted'), 'no_credit');
  assert.equal(classifyImageFailure('Metricool 500: {"message":"boom"}'), 'other');
});

// --- the sentences a person reads --------------------------------------------

test('a refused key never reads as "no AI is connected"', () => {
  // The bare `ai_provider` line says nothing is connected. That is exactly
  // wrong for a key that IS connected and is being refused: it sends somebody
  // to plug in a provider when the real job is paying a bill or rotating a key.
  const generic = plainFor('ai_provider', null).down;
  assert.match(generic, /no AI is connected/i);

  const noCredit = plainFor('ai_provider', 'no_credit').down;
  assert.match(noCredit, /out of credit/i);
  assert.doesNotMatch(noCredit, /no AI is connected/i);

  const badKey = plainFor('ai_provider', 'bad_key').down;
  assert.match(badKey, /rejected/i);
  assert.doesNotMatch(badKey, /no AI is connected/i);
});

test('a refused Metricool token says so instead of "not connected"', () => {
  assert.match(plainFor('metricool', 'bad_key').down, /rejected/i);
  assert.match(plainFor('metricool', 'not_configured').down, /not connected/i);
});

test('every FAILURE code has its own wording, so none falls back to the bare name', () => {
  // 'not_configured' is excluded on purpose: for that one the generic sentence
  // is the correct sentence — nothing is connected, which is what it says. The
  // codes that must differ are the ones where something IS connected and is
  // refusing, because the generic wording sends somebody to fix the wrong thing.
  for (const [name, codes] of [
    ['ai_provider', ['no_credit', 'bad_key', 'rate_limited', 'other']],
    ['metricool', ['bad_key', 'rate_limited', 'other']],
  ] as const) {
    for (const code of codes) {
      const narrowed = plainFor(name, code);
      const bare = plainFor(name, null);
      assert.notEqual(narrowed.down, bare.down, name + ':' + code + ' fell back to the generic sentence');
    }
  }
  // And not_configured deliberately keeps it.
  assert.equal(plainFor('ai_provider', 'not_configured').down, plainFor('ai_provider', null).down);
});

// --- the safety rule ---------------------------------------------------------

test('a transient refusal never turns a required check red', () => {
  // ai_provider and metricool are severity: 'required', so anything that flips
  // them also answers 503 and paints the banner. The stored outcome lives for
  // 24h, so counting a 429 would let one busy minute hold the dashboard red for
  // a day — a false alarm on the two checks that can least afford one. Only a
  // rejected key and an empty account qualify: both need a person, and neither
  // clears itself.
  const src = readSrc('health-checks.ts');
  assert.match(src, /function blocksWork/);
  assert.match(src, /outcome\.reason === 'bad_key' \|\| outcome\.reason === 'no_credit'/);
  assert.match(src, /const textFailing = blocksWork\(lastText\)/);
  assert.match(src, /const metricoolFailing = blocksWork\(lastMetricool\)/);
});

test('"no record" is never treated as a fault', () => {
  // THE rule. `ai_provider` and `metricool` are both severity: 'required', so
  // treating an absent record as a failure would turn a freshly deployed (or
  // simply quiet) dashboard red and answer 503 on /api/health — a false alarm
  // on the two checks that can least afford one.
  const src = readSrc('health-checks.ts');
  // Failure is asserted from an outcome that EXISTS and is not ok, never from
  // the absence of one.
  assert.match(src, /if \(!outcome \|\| outcome\.ok\) return false;/, 'blocksWork must pass a null outcome');
  // And the checks read configured-AND-not-failing, so a null outcome passes.
  assert.match(src, /ok: textConfigured && !textFailing/);
  assert.match(src, /ok: metricoolConfigured && !metricoolFailing/);
});

test('success is recorded, or a fixed key would stay red for a day', () => {
  // lastProviderOutcome returns the most recent outcome inside a 24h window.
  // Without a success write, one bad minute keeps the banner red until the
  // window expires, long after somebody fixed the key.
  const ai = readSrc('ai.ts');
  assert.match(ai, /recordProviderOutcome\(name, \{ ok: true \}\)/, 'ai.ts never records a success');
  assert.match(ai, /recordProviderOutcome\('anthropic_text', \{ ok: true \}\)/, 'the streaming pack path never records a success');
  const mc = readSrc('metricool.ts');
  assert.match(mc, /recordProviderOutcome\('metricool', \{ ok: true \}\)/, 'metricool.ts never records a success');
});

test('the provider store is no longer hardcoded to one provider', () => {
  const src = readSrc('provider-status.ts');
  assert.doesNotMatch(src, /^const PROVIDER = 'openai_images';$/m, 'the single-provider constant is back');
  assert.match(src, /export type ProviderName/);
  // And the detail it stores is redacted: it is a provider's own error text,
  // which is where a vendor has been seen echoing a live key back.
  assert.match(src, /redact\(String\(input\.message\)\)/);
});

// --- the Shared Drive setup a person has to perform --------------------------

test('the Shared Drive refusal names the account to share with', () => {
  // "Add the service account as Content manager" is not an instruction anybody
  // can follow without knowing WHICH address to type, and the only place that
  // address appeared was the Sources page — a different screen from the banner
  // reporting the fault.
  const src = readSrc('health-checks.ts');
  const at = src.indexOf('is NOT in a Shared Drive');
  assert.ok(at > 0, 'the not-in-a-Shared-Drive message is gone');
  const after = src.slice(at, at + 1200);
  assert.match(after, /serviceAccountEmail\(\)/, 'the message never names the service account');
  assert.match(after, /Content manager/);
  assert.match(after, /DRIVE_FOLDER_ID/);
});

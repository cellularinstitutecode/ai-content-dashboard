// End-to-end contract tests for the AI image pipeline, driving the REAL
// generatePackImage() against a scripted fake OpenAI.
//
// This is the only coverage the image path has, and it is the path the clinic
// cares most about: every published visual must be a pure CONTENT image with
// no words in it, and no image credit should ever be spent and thrown away.
// Each case below corresponds to a rule that was either broken in production
// or is expensive to get wrong.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generatePackImage, imagesEnabled } from '@/lib/images.ts';
import { __reset, __uploads } from '@/lib/supabase-admin';

// A minimal valid PNG header — enough for the byte-sniffer to classify it.
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

let script = [];
let calls = [];

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const bad = (status, body) => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) });

// Each scripted entry answers exactly one fetch, so an unexpected extra call
// is itself a test failure — that is how we assert on API spend.
const imageOk = (label) => ({ label, respond: async () => ok({ data: [{ b64_json: PNG_B64 }] }) });
const imageErr = (label, status, message) => ({ label, respond: async () => bad(status, { error: { message } }) });
const verifierSays = (label, verdict) => ({
  label,
  respond: async () => ok({ choices: [{ message: { content: JSON.stringify(verdict) } }] }),
});

globalThis.fetch = async (url, opts) => {
  const step = script.shift();
  if (!step) throw new Error('unexpected fetch (script exhausted): ' + String(url));
  calls.push({ label: step.label, body: opts?.body ? JSON.parse(opts.body) : null });
  return step.respond(url, opts);
};

beforeEach(() => {
  script = [];
  calls = [];
  __reset();
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.IMAGE_GEN;
  delete process.env.IMAGE_VERIFY;
});

test('a clean image is generated once, verified, and stored', async () => {
  script = [imageOk('gen'), verifierSays('verify', { approved: true, textDetected: false, score: 92, issues: [] })];
  const img = await generatePackImage({ topic: 'stem cell therapy for knees' });
  assert.equal(img.verification.status, 'approved');
  assert.equal(img.verification.textDetected, false);
  assert.equal(img.variant, 0);
  assert.match(img.url, /^https:\/\/storage\.test\/packs\//);
  assert.equal(__uploads().length, 1, 'stored exactly one object');
  assert.equal(script.length, 0, 'exactly two API calls — no wasted spend');
});

test('THE HARD RULE: text in an image forces regeneration with the next composition', async () => {
  script = [
    imageOk('gen-1'),
    verifierSays('verify-1', { approved: true, textDetected: true, score: 88, issues: ['signage with lettering'] }),
    imageOk('gen-2'),
    verifierSays('verify-2', { approved: true, textDetected: false, score: 84, issues: [] }),
  ];
  const img = await generatePackImage({ topic: 'exosome therapy', variant: 0 });
  assert.equal(img.verification.textDetected, false);
  assert.equal(img.variant, 1, 'advanced to the next composition, not a re-roll of the same prompt');
  const second = calls.find((c) => c.label === 'gen-2');
  assert.match(second.body.prompt, /macro scientific beauty/, 'used the variant-1 composition');
});

test('THE HARD RULE: a text-bearing image can never win, even with a far better score', async () => {
  script = [
    imageOk('gen-1'),
    verifierSays('verify-1', { approved: true, textDetected: true, score: 99, issues: ['caption text'] }),
    imageOk('gen-2'),
    verifierSays('verify-2', { approved: false, textDetected: false, score: 40, issues: ['uncanny hands'] }),
    imageOk('gen-3'),
    verifierSays('verify-3', { approved: false, textDetected: false, score: 35, issues: ['odd lighting'] }),
  ];
  const img = await generatePackImage({ topic: 'PRP treatment' });
  assert.equal(img.verification.textDetected, false, 'a 35-scoring text-free image beats a 99-scoring one with text');
});

test('THE HARD RULE: the verifier cannot approve its way past detected text', async () => {
  script = [
    imageOk('gen-1'),
    verifierSays('verify-1', { approved: true, textDetected: true, score: 95, issues: [] }),
    imageOk('gen-2'),
    verifierSays('verify-2', { approved: true, textDetected: false, score: 90, issues: [] }),
  ];
  const img = await generatePackImage({ topic: 'cold chain' });
  assert.equal(img.variant, 1, 'approved:true was overridden by textDetected:true');
});

test('THE HARD RULE: text mentioned only in the issue list still counts', async () => {
  script = [
    imageOk('gen-1'),
    verifierSays('verify-1', { approved: true, textDetected: false, score: 90, issues: ['garbled lettering on a bottle'] }),
    imageOk('gen-2'),
    verifierSays('verify-2', { approved: true, textDetected: false, score: 81, issues: [] }),
  ];
  const img = await generatePackImage({ topic: 'GMP manufacturing' });
  assert.equal(img.variant, 1, 'belt-and-braces catch fired even though the flag was false');
});

test('a deprecated parameter falls down the request ladder instead of failing', async () => {
  script = [
    imageErr('gen-rich', 400, 'Unknown parameter: output_compression'),
    imageOk('gen-minimal'),
    verifierSays('verify', { approved: true, textDetected: false, score: 90, issues: [] }),
  ];
  const img = await generatePackImage({ topic: 'sterility testing' });
  assert.equal(img.verification.status, 'approved');
});

test('a model-access failure falls through to the fallback model', async () => {
  script = [
    imageErr('gen-rich', 404, 'model not found'),
    imageErr('gen-minimal', 404, 'model not found'),
    imageOk('gen-fallback'),
    verifierSays('verify', { approved: true, textDetected: false, score: 90, issues: [] }),
  ];
  const img = await generatePackImage({ topic: 'cell culture' });
  assert.equal(img.model, 'gpt-image-1-mini');
});

test('exhausted credit surfaces a real error rather than a silent no-op', async () => {
  const exhausted = JSON.stringify({ error: { code: 'credit_balance_exhausted' } });
  script = [imageErr('r1', 429, exhausted), imageErr('r2', 429, exhausted), imageErr('r3', 429, exhausted)];
  await assert.rejects(
    () => generatePackImage({ topic: 'anything' }),
    (e) => /429/.test(e.message) && /credit_balance_exhausted/.test(e.message)
  );
});

test('a first-attempt failure fails FAST — no extra calls against a dead API', async () => {
  // generateImageBytes already walks its own 3-rung ladder, so retrying the
  // outer loop would triple the failed-call volume when credits are gone.
  const exhausted = JSON.stringify({ error: { code: 'credit_balance_exhausted' } });
  script = [imageErr('r1', 429, exhausted), imageErr('r2', 429, exhausted), imageErr('r3', 429, exhausted)];
  await assert.rejects(() => generatePackImage({ topic: 'anything' }), /429/);
  assert.equal(script.length, 0, 'exactly one ladder walk, not three');
});

test('a LATE failure never discards an already-paid-for image', async () => {
  // Attempt 0 yields a usable (merely flagged) image; attempt 1 dies with a
  // 500. The paid-for image must still be stored, not thrown away.
  script = [
    imageOk('gen-1'),
    verifierSays('verify-1', { approved: false, textDetected: false, score: 72, issues: ['slightly off-topic'] }),
    imageErr('gen-2', 500, 'server error'),
  ];
  const img = await generatePackImage({ topic: 'joint recovery' });
  assert.equal(img.verification.score, 72, 'the attempt-0 candidate survived');
  assert.equal(__uploads().length, 1, 'and it was actually stored');
});

test('a verifier outage never blocks the image — it ships marked for review', async () => {
  script = [imageOk('gen'), { label: 'verify-down', respond: async () => bad(500, {}) }];
  const img = await generatePackImage({ topic: 'vitality' });
  assert.equal(img.verification.status, 'unchecked');
  assert.match(img.verification.issues[0], /review the image manually/);
});

test('IMAGE_GEN=off disables generation with a clear error and spends nothing', async () => {
  process.env.IMAGE_GEN = 'off';
  assert.equal(imagesEnabled(), false);
  await assert.rejects(() => generatePackImage({ topic: 'x' }), /disabled/);
  assert.equal(calls.length, 0, 'no API call was made');
});

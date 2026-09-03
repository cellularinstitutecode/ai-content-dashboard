// The freshness half of the images capability signal.
//
// Recording the last outcome is only half the fix. Without a window, one bad
// afternoon leaves "The OpenAI account is out of credit" on the dashboard
// forever — including after somebody tops the account up — and a banner that
// is always there is a banner nobody reads. These tests pin the window itself,
// not just the constant that names it.
//
// Runs under the module hooks (see image-module-hooks.mjs) because
// lib/provider-status.ts is `server-only` and talks to Supabase. Under the
// stub the table read comes back empty, which is exactly the "older database
// that predates provider_status" case: the module must fall back to what this
// process saw rather than inventing a verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordImageOutcome, lastImageOutcome, __resetImageOutcome, OUTCOME_WINDOW_MS } from '../lib/provider-status.ts';

const OUT_OF_CREDIT =
  'openai images 429: {"error":{"message":"Your credit balance is too low","code":"credit_balance_exhausted"}}';

/** Run `fn` as if it were `msAgo` milliseconds ago. */
async function at(msAgo, fn) {
  const real = Date.now;
  Date.now = () => real() - msAgo;
  try { return await fn(); } finally { Date.now = real; }
}

test('a failure just now is reported, with the reason', async () => {
  __resetImageOutcome();
  recordImageOutcome({ ok: false, message: OUT_OF_CREDIT });
  const seen = await lastImageOutcome();
  assert.ok(seen, 'nothing was recorded');
  assert.equal(seen.ok, false);
  assert.equal(seen.reason, 'no_credit');
});

test('a failure from 23 hours ago still counts', async () => {
  __resetImageOutcome();
  await at(23 * 60 * 60 * 1000, () => recordImageOutcome({ ok: false, message: OUT_OF_CREDIT }));
  const seen = await lastImageOutcome();
  assert.ok(seen, 'a failure inside the window was discarded');
  assert.equal(seen.reason, 'no_credit');
});

test('a failure from 25 hours ago no longer counts', async () => {
  // This is the one that fails if the window is dropped: the outcome is still
  // recorded and still says no_credit, it just stops being evidence about now.
  __resetImageOutcome();
  await at(25 * 60 * 60 * 1000, () => recordImageOutcome({ ok: false, message: OUT_OF_CREDIT }));
  assert.equal(await lastImageOutcome(), null, 'a day-old failure was still being reported');
});

test('the boundary is a day, not some other number', async () => {
  __resetImageOutcome();
  await at(OUTCOME_WINDOW_MS + 60_000, () => recordImageOutcome({ ok: false, message: OUT_OF_CREDIT }));
  assert.equal(await lastImageOutcome(), null);
  __resetImageOutcome();
  await at(OUTCOME_WINDOW_MS - 60_000, () => recordImageOutcome({ ok: false, message: OUT_OF_CREDIT }));
  assert.ok(await lastImageOutcome());
});

test('a success clears a failure, so the banner comes down by itself', async () => {
  // Recording only failures would be enough to raise the alarm and nothing
  // would ever lower it.
  __resetImageOutcome();
  recordImageOutcome({ ok: false, message: OUT_OF_CREDIT });
  recordImageOutcome({ ok: true });
  const seen = await lastImageOutcome();
  assert.equal(seen.ok, true);
  assert.equal(seen.reason, null);
});

test('nothing recorded is not an alarm', async () => {
  __resetImageOutcome();
  assert.equal(await lastImageOutcome(), null);
});

test('a database that predates provider_status does not break the read', async () => {
  // The stub answers every select with no row and has no upsert at all, so
  // this exercises both the missing-table read and the failed write.
  __resetImageOutcome();
  assert.doesNotThrow(() => recordImageOutcome({ ok: false, message: OUT_OF_CREDIT }));
  const seen = await lastImageOutcome();
  assert.equal(seen.reason, 'no_credit', 'fell back to nothing instead of to memory');
});

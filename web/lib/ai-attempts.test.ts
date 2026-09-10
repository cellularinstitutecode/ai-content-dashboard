import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptPlan, MAX_ATTEMPTS, SLACK_MS, TARGET_ATTEMPT_MS } from './ai-attempts.ts';

test('the plan never promises more time than it has', () => {
  // The bug this file exists for: a fixed 3 x 30s is ~92s of attempts inside a
  // 60s reserve, so the request died in the writer with the transcript paid for.
  for (const remaining of [10_000, 45_000, 60_000, 90_000, 150_000, 300_000]) {
    const p = attemptPlan(remaining);
    assert.ok(p.attempts * p.timeoutMs <= remaining - SLACK_MS + 1,
      `plan ${p.attempts}x${p.timeoutMs} overruns ${remaining}`);
  }
});

test('a short clock buys one long try, not three doomed ones', () => {
  // A 19s ceiling does not fail faster on a call that needs 25s — it fails
  // three times instead of succeeding once.
  const p = attemptPlan(60_000);
  assert.equal(p.attempts, 1);
  assert.equal(p.timeoutMs, 55_000);
});

test('a generous clock gets the full three, still capped', () => {
  const p = attemptPlan(300_000);
  assert.equal(p.attempts, MAX_ATTEMPTS);
  assert.ok(p.timeoutMs >= TARGET_ATTEMPT_MS);
  // Not more than three however long the clock is: past a point the model is
  // not having a bad moment, the request is wrong.
  assert.equal(attemptPlan(3_600_000).attempts, MAX_ATTEMPTS);
});

test('two attempts appear only once both can be a full length', () => {
  assert.equal(attemptPlan(65_000).attempts, 2);
  assert.equal(attemptPlan(64_000).attempts, 1);
});

test('no time at all still yields one attempt', () => {
  // canWriteCopy decides whether to start. Returning zero attempts here would
  // turn a tight request into a silent no-op instead of a try that says why.
  assert.deepEqual(attemptPlan(0), { attempts: 1, timeoutMs: TARGET_ATTEMPT_MS });
  assert.deepEqual(attemptPlan(-5000), { attempts: 1, timeoutMs: TARGET_ATTEMPT_MS });
  assert.deepEqual(attemptPlan(Number.NaN), { attempts: 1, timeoutMs: TARGET_ATTEMPT_MS });
});

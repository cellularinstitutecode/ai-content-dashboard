import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReseed } from './reseed.ts';

const FLOOR = 0.5;

test('an off-topic retry is refused even when the first brief was empty', () => {
  // THE bug: `!hasSemrushData(first) || grounded(retry) > grounded(first)`
  // short-circuited, so this exact case was accepted unconditionally. It is how
  // a video about the oxygen circuit came to be headlined on red light therapy.
  const d = shouldReseed({ hasData: false, grounding: 0 }, { hasData: true, grounding: 0.1 }, FLOOR);
  assert.equal(d.accept, false);
  assert.equal(d.reason, 'not-grounded');
});

test('a well-grounded retry replaces an empty first brief', () => {
  const d = shouldReseed({ hasData: false, grounding: 0 }, { hasData: true, grounding: 0.8 }, FLOOR);
  assert.equal(d.accept, true);
  assert.equal(d.reason, 'ok');
});

test('a retry that returned nothing replaces nothing', () => {
  assert.deepEqual(
    shouldReseed({ hasData: false, grounding: 0 }, { hasData: false, grounding: 0.9 }, FLOOR),
    { accept: false, reason: 'no-data' },
  );
});

test('a grounded retry must still beat a grounded first brief', () => {
  const worse = shouldReseed({ hasData: true, grounding: 0.9 }, { hasData: true, grounding: 0.6 }, FLOOR);
  assert.equal(worse.accept, false);
  assert.equal(worse.reason, 'not-better');
  // Equal is not better: the filename may have been the truer seed, and a tie
  // should not cost a second lookup's worth of churn.
  assert.equal(shouldReseed({ hasData: true, grounding: 0.6 }, { hasData: true, grounding: 0.6 }, FLOOR).accept, false);
  assert.equal(shouldReseed({ hasData: true, grounding: 0.6 }, { hasData: true, grounding: 0.7 }, FLOOR).accept, true);
});

test('the floor is exact, not approximate', () => {
  assert.equal(shouldReseed({ hasData: false, grounding: 0 }, { hasData: true, grounding: FLOOR }, FLOOR).accept, true);
  assert.equal(shouldReseed({ hasData: false, grounding: 0 }, { hasData: true, grounding: 0.49 }, FLOOR).accept, false);
});

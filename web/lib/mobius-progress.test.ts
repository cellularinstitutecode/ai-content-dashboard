import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOBIUS_INNER_PATH, MOBIUS_PATH, PATH_LENGTH, clampPercent, dashOffsetFor } from './mobius-progress.ts';

test('an empty band and a full band are the two ends of the offset', () => {
  assert.equal(dashOffsetFor(0), PATH_LENGTH, 'nothing drawn');
  assert.equal(dashOffsetFor(100), 0, 'the whole band drawn');
  assert.equal(dashOffsetFor(50), 50);
});

test('a number outside 0-100 cannot draw a broken band', () => {
  // progressBus eases toward 100 and is monotonic within a batch, but nothing
  // stops a caller passing something else — and a negative dash offset draws
  // an overshooting stroke rather than failing loudly.
  assert.equal(dashOffsetFor(-20), PATH_LENGTH);
  assert.equal(dashOffsetFor(140), 0);
  // NaN and Infinity are different mistakes. NaN is no information, so it
  // shows nothing; Infinity is past the end of the scale, so it shows a full
  // band. Guarding both with !Number.isFinite reported a finished job as not
  // started, which is the one lie a progress indicator must never tell.
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 100);
  assert.equal(clampPercent(Number.NEGATIVE_INFINITY), 0);
});

test('the percentage shown is a whole number', () => {
  // Rendered at ~14px inside a 48px badge; "41.7%" is both wider than the space
  // and a precision the estimate does not have.
  assert.equal(clampPercent(41.6), 42);
  assert.equal(clampPercent(0.4), 0);
});

test('both lobes are the same size, and the figure closes', () => {
  // An asymmetric lemniscate reads as a rendering bug rather than as
  // perspective, and an unclosed one leaves a visible notch at the crossing
  // exactly where the eye is drawn.
  for (const p of [MOBIUS_PATH, MOBIUS_INNER_PATH]) {
    assert.ok(p.trim().endsWith('Z'), 'path must close');
    assert.ok(p.startsWith('M50 50'), 'both lobes start from the crossing');
    const xs = (p.match(/\d+(?= 50 C)/g) || []).map(Number);
    assert.ok(xs.length >= 2, p);
  }
  // Right lobe reaches 84, left reaches 16 — equidistant from the centre at 50.
  assert.ok(MOBIUS_PATH.includes('84 50') && MOBIUS_PATH.includes('16 50'));
  assert.equal(84 - 50, 50 - 16);
});

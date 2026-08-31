// The scheduling conversion that shipped wrong twice. Cancun is UTC-5 all year
// (no DST), which makes every expectation below arithmetic rather than a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublishAt, toZonedWallClock } from './metricool-time.ts';

const TZ = 'America/Cancun';

test('an absolute UTC instant is CONVERTED, not truncated', () => {
  // The old assistant copy answered '2026-09-01T14:00:00' here — it dropped the
  // Z and called 14:00 UTC "14:00 in Cancun", scheduling five hours late.
  const r = normalizePublishAt('2026-09-01T14:00:00Z', TZ);
  assert.equal(r?.wallClock, '2026-09-01T09:00:00');
  assert.equal(r?.instant, '2026-09-01T14:00:00.000Z');
});

test('an instant with a numeric offset converts the same way', () => {
  const r = normalizePublishAt('2026-09-01T07:00:00-07:00', TZ);
  assert.equal(r?.wallClock, '2026-09-01T09:00:00');
});

test('a naive value is taken as clinic wall-clock and keeps its digits', () => {
  const r = normalizePublishAt('2026-09-01T09:00', TZ);
  assert.equal(r?.wallClock, '2026-09-01T09:00:00');
  assert.equal(r?.instant, '2026-09-01T14:00:00.000Z');
});

test('a conversion round-trips', () => {
  const r = normalizePublishAt('2026-12-25T18:30', TZ);
  assert.equal(toZonedWallClock(new Date(r!.instant), TZ), '2026-12-25T18:30:00');
});

test('midnight does not render as hour 24', () => {
  assert.equal(toZonedWallClock(new Date('2026-09-02T05:00:00Z'), TZ), '2026-09-02T00:00:00');
});

test('unusable input is rejected rather than guessed at', () => {
  for (const bad of ['', '   ', 'tomorrow', '2026-09-01', 'not-a-date']) {
    assert.equal(normalizePublishAt(bad, TZ), null, JSON.stringify(bad) + ' should be rejected');
  }
});

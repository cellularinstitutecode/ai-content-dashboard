import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricDate, metricNetwork, syntheticBasis } from './metric-fields.ts';

test('the stored published_at is read from a string, a number or an object', () => {
  assert.equal(metricDate('2026-10-05T14:00:00Z'), '2026-10-05T14:00:00.000Z');
  assert.equal(metricDate({ dateTime: '2026-10-05T14:00:00Z', timezone: 'America/Cancun' }), '2026-10-05T14:00:00.000Z');
  assert.equal(metricDate(1791208800), new Date(1791208800 * 1000).toISOString(), 'seconds');
  assert.equal(metricDate(1791208800000), new Date(1791208800000).toISOString(), 'milliseconds');
  assert.equal(metricDate('not a date'), null);
  assert.equal(metricDate({}), null);
  assert.equal(metricDate(null), null);
});

// The row's key must be exactly what the sync always produced, or the next
// sync inserts every post a second time beside its old row.
const OLD_NETWORK = (row: Record<string, unknown>) => {
  for (const k of ['network', 'provider', 'platform']) if (row[k] != null) return String(row[k]);
  return 'unknown';
};
const OLD_BASIS = (network: string, publishedAt: unknown, text: string | null) =>
  [network, publishedAt ?? '', (text ?? '').slice(0, 200)].join('|');

test('the network is stored exactly as before — raw, and never from `type`', () => {
  for (const row of [
    { network: 'Instagram' },
    { provider: 'facebook' },
    { platform: 'LinkedIn' },
    { type: 'REEL', text: 'x' },
    { socialNetwork: 'instagram' },
    {},
  ]) {
    assert.equal(metricNetwork(row), OLD_NETWORK(row), JSON.stringify(row));
  }
  assert.equal(metricNetwork({ network: 'Instagram' }), 'Instagram', 'not lower-cased: that would change the key');
  assert.equal(metricNetwork({ type: 'REEL' }), 'unknown', 'a post format is not a network');
  assert.equal(metricNetwork(null), 'unknown');
});

test('an id-less row hashes the same basis as before, whatever shape its date has', () => {
  for (const date of ['2026-10-05 09:00:00', '2026-10-05T14:00:00Z', 1791208800, undefined, null]) {
    const text = 'Eight hours in bed is not the same as rest.';
    assert.equal(syntheticBasis('Instagram', date, text), OLD_BASIS('Instagram', date ?? null, text), JSON.stringify(date));
  }
});

test('an object date is part of the key, so two posts sharing a caption do not collide', () => {
  const text = 'Save this for tonight.';
  const a = syntheticBasis('instagram', { dateTime: '2026-10-05T09:00:00Z' }, text);
  const b = syntheticBasis('instagram', { dateTime: '2026-10-12T09:00:00Z' }, text);
  assert.notEqual(a, b);
  assert.ok(!a.includes('[object Object]'));
});

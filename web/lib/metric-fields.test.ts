import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricDate, metricNetwork } from './metric-fields.ts';

test('a publication date is read from a string, a number or an object', () => {
  assert.equal(metricDate('2026-10-05T14:00:00Z'), '2026-10-05T14:00:00.000Z');
  assert.equal(metricDate({ dateTime: '2026-10-05T14:00:00Z', timezone: 'America/Cancun' }), '2026-10-05T14:00:00.000Z');
  assert.equal(metricDate(1791208800), new Date(1791208800 * 1000).toISOString(), 'seconds');
  assert.equal(metricDate(1791208800000), new Date(1791208800000).toISOString(), 'milliseconds');
  assert.equal(metricDate('not a date'), null);
  assert.equal(metricDate({}), null);
  assert.equal(metricDate(null), null);
});

test('the network is found under the names Metricool rows use', () => {
  assert.equal(metricNetwork({ network: 'Instagram' }), 'instagram');
  assert.equal(metricNetwork({ socialNetwork: 'LINKEDIN' }), 'linkedin');
  assert.equal(metricNetwork({ provider: 'facebook' }), 'facebook');
  assert.equal(metricNetwork({ text: 'x' }), 'unknown');
  assert.equal(metricNetwork(null), 'unknown');
});

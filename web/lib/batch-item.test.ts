import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchItemProblem } from './batch-item.ts';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const ok = { topic: 'NK cells', network: 'instagram', publishAt: '2026-06-01T09:00:00Z' };

test('a usable item has no problem', () => {
  assert.equal(batchItemProblem(ok, NOW), null);
});

test('every supported network is accepted, in any case', () => {
  for (const n of ['facebook', 'instagram', 'twitter', 'x', 'linkedin', 'tiktok', 'youtube', 'threads']) {
    assert.equal(batchItemProblem({ ...ok, network: n.toUpperCase() }, NOW), null, n);
  }
});

test('an unknown network is named in the refusal', () => {
  assert.match(String(batchItemProblem({ ...ok, network: 'myspace' }, NOW)), /myspace/);
});

// The reason this module exists: these must be caught before a rate-limit token
// is spent, because checkRateLimit consumes on success rather than peeking.
test('a past date is refused rather than queued', () => {
  assert.match(String(batchItemProblem({ ...ok, publishAt: '2025-01-01T09:00:00Z' }, NOW)), /already passed/);
  assert.match(String(batchItemProblem({ ...ok, publishAt: '2026-01-01T00:00:00Z' }, NOW)), /already passed/, 'exactly now is not the future');
});

test('an unparseable date is told apart from a missing one', () => {
  assert.match(String(batchItemProblem({ ...ok, publishAt: 'next tuesday' }, NOW)), /not a usable date/);
  assert.match(String(batchItemProblem({ ...ok, publishAt: '' }, NOW)), /No date and time/);
});

test('missing fields each say which one', () => {
  assert.match(String(batchItemProblem({ ...ok, topic: '   ' }, NOW)), /No topic/);
  assert.match(String(batchItemProblem({ ...ok, network: '' }, NOW)), /No network/);
});

test('nothing at all still produces a sentence rather than throwing', () => {
  assert.ok(batchItemProblem({} as Record<string, unknown>, NOW));
  assert.ok(batchItemProblem(undefined as unknown as Record<string, unknown>, NOW));
});

// The Semrush spend POLICY: who may spend, before the budget asks how much.
// Run with: npm test
//
// The regression this guards against is a month's worth of units going to
// jobs nobody asked for — the hourly Autopilot, the 15-minute video watcher,
// a strategy drop, the voice session's warm-up, the SEO panel opening on page
// load — each running live keyword lookups on its own schedule. The gate's
// safe answer is "no": work that did not go through withUserSemrush() is
// automatic, and automatic work spends nothing in the default mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentSemrushOrigin,
  liveAllowedByPolicy,
  parseSemrushMode,
  withDraftSemrush,
  withUserSemrush,
} from './semrush-policy.ts';

test('the default mode is manual, and anything unrecognised falls back to it', () => {
  assert.equal(parseSemrushMode(undefined), 'manual');
  assert.equal(parseSemrushMode(''), 'manual');
  assert.equal(parseSemrushMode('yes please'), 'manual');
  assert.equal(parseSemrushMode(' AUTO '), 'auto');
  assert.equal(parseSemrushMode('Off'), 'off');
  assert.equal(parseSemrushMode('manual'), 'manual');
});

test('manual: only a person may spend', () => {
  assert.equal(liveAllowedByPolicy('manual', 'user'), true);
  assert.equal(liveAllowedByPolicy('manual', 'auto'), false);
});

test('off: nobody spends, not even a person', () => {
  assert.equal(liveAllowedByPolicy('off', 'user'), false);
  assert.equal(liveAllowedByPolicy('off', 'auto'), false);
});

test('auto: the old behaviour, everything inside the budget may spend', () => {
  assert.equal(liveAllowedByPolicy('auto', 'user'), true);
  assert.equal(liveAllowedByPolicy('auto', 'auto'), true);
});

test('work is automatic unless it runs inside withUserSemrush()', async () => {
  assert.equal(currentSemrushOrigin(), 'auto');
  const seen = await withUserSemrush(async () => {
    // The origin follows the async chain, however deep.
    await new Promise((r) => setTimeout(r, 1));
    return currentSemrushOrigin();
  });
  assert.equal(seen, 'user');
  // And it does not leak out of the wrapper.
  assert.equal(currentSemrushOrigin(), 'auto');
});

test('a user-origin wrapper does not mark unrelated concurrent work', async () => {
  let inside: string | null = null;
  let outside: string | null = null;
  await Promise.all([
    withUserSemrush(async () => {
      await new Promise((r) => setTimeout(r, 2));
      inside = currentSemrushOrigin();
    }),
    (async () => {
      await new Promise((r) => setTimeout(r, 1));
      outside = currentSemrushOrigin();
    })(),
  ]);
  assert.equal(inside, 'user');
  assert.equal(outside, 'auto');
});

test('manual: drafting may spend too — from its own pot — and nothing else automatic may', () => {
  assert.equal(liveAllowedByPolicy('manual', 'draft'), true);
  assert.equal(liveAllowedByPolicy('manual', 'auto'), false);
  assert.equal(liveAllowedByPolicy('off', 'draft'), false);
  assert.equal(liveAllowedByPolicy('auto', 'draft'), true);
});

test('work is drafting only inside withDraftSemrush(), and the origin does not leak', async () => {
  const seen = await withDraftSemrush(async () => {
    await new Promise((r) => setTimeout(r, 1));
    return currentSemrushOrigin();
  });
  assert.equal(seen, 'draft');
  assert.equal(currentSemrushOrigin(), 'auto');
  // A person's click inside drafting stays a person's click: the inner wrapper wins.
  const inner = await withDraftSemrush(() => withUserSemrush(async () => currentSemrushOrigin()));
  assert.equal(inner, 'user');
});

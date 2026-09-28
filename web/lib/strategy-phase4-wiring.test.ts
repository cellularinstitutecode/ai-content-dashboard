// web/lib/strategy-phase4-wiring.test.ts
// Phase 4's screens and route cannot be loaded by the test runner (React, and
// `server-only` imports), so these are source checks on the lines that connect
// them to the pure modules the other tests exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the planner shows the mix and each slot\'s next deal', () => {
  const planner = src('components/WeeklyPlanner.tsx');
  assert.match(planner, /plannedMix\(templates\)/);
  assert.match(planner, /nextOccurrence\(t, new Date\(now\), tz\)/, 'in the clinic\'s configured zone');
  assert.match(planner, /const tz = scheduleTz\(\)/);
  assert.match(planner, /isSeededSlot\(t\) && t\.strategy\?\.slot/, 'the engine\'s rule for a strategy slot');
  assert.match(planner, /<MixPanel mix=\{mix\} \/>/);
  assert.match(planner, /<NextLine next=/);
});

test('the performance route reads only stored rows, and only this account\'s', () => {
  const route = src('app/api/strategy/performance/route.ts');
  assert.doesNotMatch(route, /from '@\/lib\/metricool'/, 'no Metricool call on page open');
  for (const table of ['schedule_templates', 'template_runs', 'posts', 'post_metrics']) {
    const at = route.indexOf("from('" + table + "')");
    assert.ok(at > 0, table);
    assert.match(route.slice(at, at + 400), /\.eq\('user_id', user\.id\)/, table + ' is scoped to the caller');
  }
  assert.match(route, /\.eq\('state', 'approved'\)/);
  assert.match(route, /isLivePost\(row, now\)/, 'only posts that actually went out');
  assert.doesNotMatch(route, /from\('drafts'\)/, 'the pack can be edited after approval; the sent text cannot');
  assert.match(route, /String\(st\?\.seeded \|\| ''\) === 'weekly-strategy'/);
  assert.match(route, /checkRateLimit\(user\.id, 'strategy-performance'\)/);
  assert.match(route, /isAllowedEmail\(user\.email\)/);
  assert.match(src('app/templates/page.tsx'), /<StrategyPerformance \/>/);
});

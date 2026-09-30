// web/lib/library-cron.test.ts
// The Image Library reads itself: nobody has to press the button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a cron reads the folder in passes, and stops when there is nothing to read or nowhere to put it', () => {
  const cron = JSON.parse(src('vercel.json')) as { crons: { path: string; schedule: string }[] };
  assert.ok(cron.crons.some((c) => c.path === '/api/library/index' && c.schedule === '*/20 * * * *'));
  const route = src('app/api/library/index/route.ts');
  assert.match(route, /auth === 'Bearer ' \+ secret/, 'the cron secret, like the tick');
  assert.match(route, /requireAllowlistedUser\(\)/, 'or a person on the allowlist');
  assert.match(route, /if \(!\(await libraryTableReady\(\)\)\) return NextResponse\.json\(\{ ok: true, skipped: 'no_table'/);
  assert.match(route, /before\.indexed >= before\.total\) return NextResponse\.json\(\{ ok: true, skipped: 'all_read'/);
  assert.match(route, /indexLibrary\(\{ max: PER_PASS, budgetMs: 270_000 \}\)/);
  // And the indexer itself never captions into a table that is not there.
  const index = src('lib/library-index.ts');
  assert.match(index, /if \(!\(await libraryTableReady\(\)\)\) return report;/);
});

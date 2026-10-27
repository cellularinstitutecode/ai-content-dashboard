// web/lib/tick-scheduler-wiring.test.ts
// The dashboard's "Prepare checked boxes" panel sends through the same door
// the sheet's script does, and the Video Library draws it. Source checks: the
// component and the route cannot be loaded by the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the panel lists rows from /api/videos/ticks and sends each through /api/videos/row with publishAt', () => {
  const c = src('components/TickScheduler.tsx');
  assert.match(c, /fetch\('\/api\/videos\/ticks'\)/);
  assert.match(c, /fetch\('\/api\/videos\/row', \{ method: 'POST'[\s\S]*publishAt \}\)/);
  // One row at a time, so the dashboard can move the second to the next free slot.
  assert.match(c, /for \(const r of toSend\) \{[\s\S]*await fetch\('\/api\/videos\/row'/);
});

test('the Video Library draws the button, and the listing route applies the tested rule', () => {
  assert.match(src('components/SourcesView.tsx'), /<TickScheduler disabled=\{running\} \/>/);
  const route = src('app/api/videos/ticks/route.ts');
  assert.match(route, /tickRows\(/);
  assert.match(route, /\.eq\('state', 'prepared'\)/);
});

test('a tick that names no time is held by the route, unless VIDEO_TICK_INSTANT is on', () => {
  const route = src('app/api/videos/row/route.ts');
  assert.match(route, /const hold = !publishAt && !instantTicksEnabled\(\);/);
  assert.match(route, /addTickedNetworks\(\{ userId, tab, row, publishAt, hold,/);
});

test('the panel pre-selects only the rows just ticked in the sheet, and can move a finished row’s posts', () => {
  const c = src('components/TickScheduler.tsx');
  assert.match(c, /setChosen\(new Set\(j\.rows\.filter\(\(x\) => x\.pending && /);
  assert.match(c, /action: 'reschedule', publication_date: iso/);
  // Published posts are never moved.
  assert.match(c, /p\.status !== 'published'/);
  const route = src('app/api/videos/ticks/route.ts');
  assert.match(route, /only: \['ticked', 'queued'\]/);
  assert.match(route, /pendingTicks\(lines\)/);
});


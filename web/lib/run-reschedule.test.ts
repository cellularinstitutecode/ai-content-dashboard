// web/lib/run-reschedule.test.ts
// "Reschedule" on a missed Autopilot draft: its time moves, the draft stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcilePlan } from './run-reconcile.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a moved run keeps its draft, marks itself redated so the reconcile pass leaves it, and refuses a doubled slot', () => {
  const ap = src('lib/autopilot.ts');
  const fn = ap.slice(ap.indexOf('export async function rescheduleRun'), ap.indexOf('export async function skipRun'));
  assert.match(fn, /redatedFrom: row\.scheduled_for/);
  assert.match(fn, /\.update\(\{ scheduled_for: at\.toISOString\(\), angle, log:/);
  assert.match(fn, /\.eq\('state', row\.state\)/, 'an approval from another tab wins');
  assert.match(fn, /already has a post at that time/);
  assert.match(fn, /row\.state === 'approved' \|\| row\.state === 'skipped' \|\| row\.state === 'superseded'/);
  // The marker is the one the reconcile pass honours.
  const later = new Date(Date.now() + 5 * 86400000).toISOString();
  const plan = reconcilePlan([{ id: 'moved', state: 'ready_for_review', scheduled_for: later, angle: { redatedFrom: 'x' } }], { weekdays: [1], time_of_day: '09:00' });
  assert.deepEqual(plan, { remove: [], supersede: [] });
});

test('the route takes it, and the calendar offers it on the missed row and in the preview', () => {
  const route = src('app/api/autopilot/runs/route.ts');
  assert.match(route, /if \(action === 'reschedule'\) \{/);
  assert.match(route, /rescheduleRun\(id, user\.id, when\)/);
  const page = src('app/calendar/page.tsx');
  assert.match(page, /onClick=\{\(\) => openRescheduleRun\(r\)\}/, 'on the missed row');
  assert.match(page, /onReschedule=\{\(\) => openRescheduleRun\(previewRun\)\}/, 'in the preview');
  assert.match(page, /action: 'reschedule', scheduled_for: iso/);
  assert.match(page, /if \(kind === 'run'\) await rescheduleRunTo\(id, iso\);/);
  assert.match(src('components/RunPreview.tsx'), /onReschedule && \(/);
});

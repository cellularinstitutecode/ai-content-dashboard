import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcilePlan, slotMatches } from './run-reconcile.ts';

const TZ = 'America/Cancun';
const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// Sunday 27 Sep 2026, 12:00 Cancun. Tuesday 29 Sep 09:00 Cancun is 14:00Z.
const NOW = Date.parse('2026-09-27T17:00:00Z');
const TUE_0900 = '2026-09-29T14:00:00.000Z';
const TUE_1000 = '2026-09-29T15:00:00.000Z';
const NEXT_TUE_0900 = '2026-10-06T14:00:00.000Z';

test('a slot matches only its own day and time, in the clinic\'s zone', () => {
  assert.equal(slotMatches(TUE_0900, [2], '09:00', TZ), true);
  assert.equal(slotMatches(TUE_0900, [2], '09:00:00', TZ), true, 'the column\'s HH:MM:SS form');
  assert.equal(slotMatches(TUE_0900, [2], '10:00', TZ), false);
  assert.equal(slotMatches(TUE_0900, [3], '09:00', TZ), false);
  assert.equal(slotMatches('not a date', [2], '09:00', TZ), false);
});

test('moving Tuesday 09:00 to 10:00 retires the old runs, keeps what is already right', () => {
  const runs = [
    { id: 'planned-old', state: 'planned', scheduled_for: NEXT_TUE_0900 },
    { id: 'drafted-old', state: 'drafted', scheduled_for: TUE_0900 },
    { id: 'ready-old', state: 'ready_for_review', scheduled_for: TUE_0900 },
    { id: 'new', state: 'planned', scheduled_for: TUE_1000 },
    { id: 'approved', state: 'approved', scheduled_for: TUE_0900 },
    { id: 'past', state: 'drafted', scheduled_for: '2026-09-22T14:00:00.000Z' },
    { id: 'redated', state: 'ready_for_review', scheduled_for: '2026-09-29T19:15:00.000Z', angle: { redatedFrom: '2026-09-22T14:00:00.000Z' } },
  ];
  const plan = reconcilePlan(runs, { weekdays: [2], time_of_day: '10:00', active: true }, NOW, TZ);
  assert.deepEqual(plan.remove, ['planned-old'], 'nothing spent on it: removed');
  assert.deepEqual(plan.supersede.sort(), ['drafted-old', 'ready-old'], 'work kept, never sent');
});

test('a paused template drops its planned runs instead of letting them expire as failures', () => {
  const runs = [
    { id: 'p', state: 'planned', scheduled_for: TUE_0900 },
    { id: 'd', state: 'drafted', scheduled_for: TUE_0900 },
  ];
  const plan = reconcilePlan(runs, { weekdays: [2], time_of_day: '09:00', active: false }, NOW, TZ);
  assert.deepEqual(plan.remove, ['p']);
  assert.deepEqual(plan.supersede, [], 'a written post is kept in case the slot comes back');
});

test('wiring: every save reconciles, and neither advance nor approve acts on a moved slot', () => {
  assert.match(src('app/api/templates/route.ts'), /await reconcileTemplateRuns\(user\.id, savedId\)/);
  const admin = src('lib/planner-admin.ts');
  assert.match(admin, /await reconcileTemplateRuns\(userId, String\(/, 'the assistant\'s save');
  assert.match(admin, /await reconcileTemplateRuns\(userId, id\)/, 'and its pause/resume');
  const ap = src('lib/autopilot.ts');
  const advance = ap.slice(ap.indexOf('export async function advanceRuns'), ap.indexOf('export type ApproveOptions'));
  assert.match(advance, /!slotMatches\(raw\.scheduled_for, template\.weekdays, template\.time_of_day, SCHEDULE_TZ\)/);
  const approve = ap.slice(ap.indexOf('export async function approveRun'));
  assert.match(approve, /!slotMatches\(run\.scheduled_for, tpl\.weekdays, tpl\.time_of_day, SCHEDULE_TZ\)/);
  // And a retired run does not move the rotation on.
  assert.match(ap, /\.neq\('state', 'superseded'\)\s*\.lt\('scheduled_for', run\.scheduled_for\)/);
});

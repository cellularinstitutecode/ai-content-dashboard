import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketRuns, isMissed, FAILED_WINDOW_DAYS, MISSED_RETIRE_DAYS } from './review-queue.ts';
import { nextFreeSlot } from './missed-slot.ts';
import { wallClockInTz } from './timezone.ts';

const NOW = Date.parse('2026-09-27T15:00:00Z');
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3600_000).toISOString();

test('old failures can no longer push the posts waiting for approval off the queue', () => {
  // The reported shape: 30 old failures and 3 ready posts. The old merge sorted
  // ascending and kept 20, so every row it returned was a failure.
  const failed = Array.from({ length: 30 }, (_, i) => ({ id: 'f' + i, state: 'failed', scheduled_for: iso(-24 * (i + 2)) }));
  const ready = [
    { id: 'r1', state: 'ready_for_review', scheduled_for: iso(20) },
    { id: 'r2', state: 'ready_for_review', scheduled_for: iso(5) },
    { id: 'r3', state: 'ready_for_review', scheduled_for: iso(-30) },
  ];
  const out = bucketRuns({ ready, inFlight: [], failed }, NOW, { ready: 50, inFlight: 20, failed: 20 });
  assert.deepEqual(out.slice(0, 3).map((r) => r.id), ['r3', 'r2', 'r1'], 'missed first, then soonest');
  assert.equal(out.filter((r) => r.state === 'failed').length, 20, 'failures are limited on their own');
  assert.equal(out[0].missed, true);
  assert.equal(out[1].missed, false);
});

test('buckets keep their own order and a run is listed once', () => {
  const out = bucketRuns({
    ready: [{ id: 'a', state: 'ready_for_review', scheduled_for: iso(3) }],
    inFlight: [
      { id: 'b', state: 'drafted', scheduled_for: iso(10) },
      { id: 'c', state: 'planned', scheduled_for: iso(2) },
      { id: 'a', state: 'ready_for_review', scheduled_for: iso(3) },
    ],
    failed: [
      { id: 'd', state: 'failed', scheduled_for: iso(-100) },
      { id: 'e', state: 'failed', scheduled_for: iso(-2) },
    ],
  }, NOW);
  assert.deepEqual(out.map((r) => r.id), ['a', 'c', 'b', 'e', 'd']);
});

test('a slot inside the five-minute margin already counts as missed', () => {
  assert.equal(isMissed({ state: 'ready_for_review', scheduled_for: new Date(NOW + 2 * 60_000).toISOString() }, NOW), true);
  assert.equal(isMissed({ state: 'ready_for_review', scheduled_for: iso(1) }, NOW), false);
  assert.equal(isMissed({ state: 'drafted', scheduled_for: iso(-5) }, NOW), false, 'only a finished post can be missed');
  assert.ok(FAILED_WINDOW_DAYS > 0 && MISSED_RETIRE_DAYS > 0);
});

test('next free slot: inside posting hours, clear of what is already going out', () => {
  const tz = 'America/Cancun';
  // 15:00Z is 10:00 in Cancun (UTC-5, no DST).
  const now = new Date(NOW);
  const first = nextFreeSlot({ now, tz });
  assert.ok(first);
  const w = wallClockInTz(first!, tz);
  assert.deepEqual([w.hh, w.mm], [10, 15], 'fifteen minutes out, on the quarter hour');

  // Something is going out at 10:30 local: the slot must be an hour clear of it.
  const busy = [new Date(Date.parse('2026-09-27T15:30:00Z'))];
  const clear = nextFreeSlot({ now, tz, busy });
  const wc = wallClockInTz(clear!, tz);
  assert.deepEqual([wc.hh, wc.mm], [11, 30]);
});

test('next free slot: after the window closes it moves to the next morning', () => {
  const tz = 'America/Cancun';
  const late = new Date(Date.parse('2026-09-28T02:00:00Z')); // 21:00 local on the 27th
  const slot = nextFreeSlot({ now: late, tz });
  const w = wallClockInTz(slot!, tz);
  assert.deepEqual([w.d, w.hh, w.mm], [28, 8, 0]);
});

test('next free slot: gives up rather than inventing a time when nothing fits', () => {
  const now = new Date(NOW);
  const busy = Array.from({ length: 7 * 24 * 4 + 8 }, (_, i) => new Date(NOW + i * 15 * 60_000));
  assert.equal(nextFreeSlot({ now, busy, searchDays: 7 }), null);
});

// Source checks: approveRun and the queue route import `server-only`.
const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('wiring: a past slot is refused unless the reviewer asked for the next free slot', () => {
  const ap = src('lib/autopilot.ts');
  const approve = ap.slice(ap.indexOf('export async function approveRun'));
  assert.match(approve, /if \(isMissed\(run\)\) \{[\s\S]*?if \(!opts\.redate\) \{[\s\S]*?releaseClaim/, 'a missed slot must be released, not sent with a past date');
  assert.match(approve, /redateClaimedRun\(db, run\)/);
  // And the engine never moves a post on its own.
  const auto = ap.slice(ap.indexOf('async function autoSchedule'), ap.indexOf('export async function advanceRuns'));
  assert.match(auto, /if \(isMissed\(run\)\) \{\s*await hold\(/);
  assert.doesNotMatch(auto, /redate:\s*true/);
});

test('wiring: the queue route reads its buckets separately and keeps failures to a window', () => {
  const route = src('app/api/autopilot/runs/route.ts');
  assert.match(route, /bucketRuns\(/);
  assert.match(route, /\.eq\('state', 'failed'\)\s*\.gte\('scheduled_for', failedSince\)/);
  assert.doesNotMatch(route, /\.slice\(0, limit\)/, 'the old merge-and-cut is what hid every ready post');
  assert.match(route, /redate: body\?\.redate === true/);
});

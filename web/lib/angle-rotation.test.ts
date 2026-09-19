// web/lib/angle-rotation.test.ts
//
// lib/autopilot.ts had no tests at all, and the rotation is the one piece of it
// that decides whether a returning pillar reads as a series or as the same post
// again. These are its first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANGLE_HISTORY,
  ANGLE_ORDER,
  chooseAngle,
  lastType,
  pastQueries,
  type RotatableAngle,
} from './angle-rotation.ts';

const ALL: RotatableAngle[] = [
  { type: 'answer', query: 'what is hbot' },
  { type: 'commercial', query: 'stem cell therapy cost' },
  { type: 'defense', query: 'regenerative medicine cancun' },
  { type: 'opportunity', query: 'nad iv therapy' },
];

test('with no history, the occurrence index alone rotates the angle', () => {
  // Four occurrences, four different jobs — the behaviour that existed before
  // any history was read, and which must survive reading it.
  const picked = [0, 1, 2, 3].map((i) => chooseAngle(ALL, i)!.type);
  assert.deepEqual(picked, [...ANGLE_ORDER]);
  // And it wraps.
  assert.equal(chooseAngle(ALL, 4)!.type, 'answer');
  assert.equal(chooseAngle(ALL, 7)!.type, 'opportunity');
});

test('a query this template already used is skipped, even when the rotation wants it', () => {
  // THE POINT OF THE FILE. Occurrence 0 wants 'answer'; the template wrote
  // that exact query last week. It gets the next one in the rotation instead.
  const history = [{ type: 'answer', query: 'What Is HBOT' }];
  const got = chooseAngle(ALL, 0, history)!;
  assert.notEqual(got.query.toLowerCase(), 'what is hbot');
  assert.equal(got.type, 'commercial');
});

test('the type used last time is skipped too, so two occurrences do not read alike', () => {
  // Same query is the loud repeat; the same TYPE two weeks running is the quiet
  // one — two "here is what it costs" posts in a row from the same pillar.
  const history = [{ type: 'answer', query: 'something else entirely' }];
  const got = chooseAngle(ALL, 0, history)!;
  assert.notEqual(got.type, 'answer');
});

test('when every query has been used, it still returns an angle', () => {
  // Fail-open. A run that writes a repeat is recoverable; a run that writes
  // nothing because its history was full is a hole in the calendar.
  const history = ALL.map((a) => ({ type: a.type, query: a.query }));
  const got = chooseAngle(ALL, 2, history);
  assert.ok(got, 'must not return null with candidates available');
  assert.equal(got!.type, 'defense', 'falls back to the rotation it would have used');
});

test('one usable angle is chosen whatever the rotation asked for', () => {
  const only: RotatableAngle[] = [{ type: 'opportunity', query: 'peptide therapy' }];
  for (const i of [0, 1, 2, 3]) assert.equal(chooseAngle(only, i)!.type, 'opportunity');
});

test('no candidates means no angle — the caller has its own fallback', () => {
  assert.equal(chooseAngle([], 0), null);
  assert.equal(chooseAngle([], 3, [{ type: 'answer', query: 'x' }]), null);
});

test('history reading is defensive, because the column is jsonb', () => {
  // template_runs.angle is jsonb written by an older version of this engine,
  // by a migration, or by hand. Anything can be in there.
  assert.deepEqual([...pastQueries([null, undefined, {}, { query: 42 }, { query: '  Hello  ' }])], ['hello']);
  assert.equal(lastType([null, { type: null }, { type: 'Defense' }]), 'defense');
  assert.equal(lastType([]), '');
  assert.doesNotThrow(() => chooseAngle(ALL, 0, [null, undefined, { query: {} }]));
});

test('the history is capped, so an old template does not rule out its whole bank', () => {
  const long = Array.from({ length: 50 }, (_, i) => ({ type: 'answer', query: 'q' + i }));
  assert.equal(pastQueries(long).size, ANGLE_HISTORY);
  assert.equal(pastQueries(long, 3).size, 3);
  // Newest first: the cap keeps the recent end, which is the end that matters.
  assert.ok(pastQueries(long).has('q0'));
  assert.ok(!pastQueries(long).has('q49'));
});

test('a negative or fractional occurrence index still lands inside the rotation', () => {
  // The index is a database count that has been null before now (see
  // lib/autopilot.ts) — an out-of-range value must not throw or pick nothing.
  for (const i of [-1, -5, 2.7, Number.NaN]) {
    const got = chooseAngle(ALL, Number.isNaN(i) ? 0 : i);
    assert.ok(got, 'index ' + i + ' produced no angle');
  }
});

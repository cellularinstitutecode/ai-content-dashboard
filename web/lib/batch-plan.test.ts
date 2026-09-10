import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mayStartBatch, tally } from './batch-plan.ts';

const READY = { tab: 'Sept', hasAiColumns: true };
const NEEDS = { tab: 'Oct', hasAiColumns: false };

test('a tab that already has the columns runs whatever the plan call did', () => {
  // The common case, and the reason refusing is affordable: this sheet's tab has had
  // KEYWORDS/REF/ESTADO IA since the first successful run, so nothing here can be harmed
  // by a failed plan call.
  assert.deepEqual(mayStartBatch([READY], ['Sept'], 'the dashboard could not be reached'), { ok: true });
  assert.deepEqual(mayStartBatch([READY, READY], [], null), { ok: true });
});

test('a tab that NEEDS the columns refuses when they could not be added', () => {
  const out = mayStartBatch([NEEDS], ['Oct'], null);
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.reason : '', /Oct/);
  assert.match(out.ok === false ? out.reason : '', /two sets/);
});

test('a tab that needs the columns refuses when the plan call itself failed', () => {
  // The client cannot tell "columns fine, slots unavailable" from "columns never
  // ensured", and proceeding on that ambiguity is the race.
  const out = mayStartBatch([NEEDS], [], 'the dashboard could not be reached');
  assert.equal(out.ok, false);
  assert.equal(out.ok === false ? out.reason : '', 'the dashboard could not be reached');
});

test('a failure on a tab nobody selected does not stop the run', () => {
  assert.deepEqual(mayStartBatch([NEEDS], ['SomeOtherTab'], null), { ok: true });
});

test('one needy tab among ready ones stops everything', () => {
  // Not "run the ready ones and skip the rest": a partial batch with no explanation is
  // how a person ends up re-running the whole thing.
  const out = mayStartBatch([READY, NEEDS, READY], ['Oct'], null);
  assert.equal(out.ok, false);
});

test('an empty selection is not an error', () => {
  assert.deepEqual(mayStartBatch([], ['Oct'], 'boom'), { ok: true });
});

test('the live tally counts a run in progress, not just a finished one', () => {
  // summarise() counts what mapLimit returned, which only exists once every row is done —
  // so for the minutes a batch is running there was no aggregate anywhere, and the only
  // sign of life was per-row text a thousand pixels below the fold.
  assert.deepEqual(tally(['done', 'working', 'queued', 'failed', 'needs_transcript']), {
    total: 5, done: 1, failed: 1, needsTranscript: 1, pending: 2,
  });
});

test('nothing running tallies to nothing', () => {
  assert.equal(tally([]), null);
});

test('a finished run has nothing pending', () => {
  const t = tally(['done', 'done', 'failed']);
  assert.equal(t?.pending, 0);
  assert.equal(t?.done, 2);
});

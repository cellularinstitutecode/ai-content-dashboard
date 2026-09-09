import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapLimit } from './map-limit.ts';

test('never more than the limit are in flight at once', async () => {
  // The whole point: firing all of them would overshoot Semrush's unit floor by the size
  // of the burst, and that floor guards real money.
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapLimit(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return n;
  });
  assert.equal(peak, 4);
});

test('results come back in input order, not finishing order', async () => {
  // The caller reports per row; a run that reports them jumbled is hard to follow even
  // when it is correct.
  const out = await mapLimit([30, 1, 20, 2], 4, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(out, [30, 1, 20, 2]);
});

test('a slow item holds up its own lane only', async () => {
  const started: number[] = [];
  await mapLimit([50, 1, 1, 1], 2, async (ms, i) => {
    started.push(i);
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  // With a width of 2, the three fast items all get through while the slow one runs.
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test('an empty list and a limit wider than the list are both fine', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit([1, 2], 99, async (n) => n * 2), [2, 4]);
  // A nonsensical limit must not mean "never run anything".
  assert.deepEqual(await mapLimit([1, 2], 0, async (n) => n), [1, 2]);
});

test('the index passed through is the input index', async () => {
  // The batch uses it to look up the slot reserved for that row; off-by-one here would
  // give a row somebody else's posting time.
  const seen = await mapLimit(['a', 'b', 'c'], 2, async (_v, i) => i);
  assert.deepEqual(seen, [0, 1, 2]);
});

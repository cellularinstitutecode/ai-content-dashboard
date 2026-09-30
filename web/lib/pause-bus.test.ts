// web/lib/pause-bus.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginQueue, isPaused, queuesRunning, resetPauseBus, setPaused, subscribePause, whenResumed } from '../components/pauseBus.ts';

test('not paused: whenResumed resolves at once', async () => {
  resetPauseBus();
  let done = false;
  await whenResumed().then(() => { done = true; });
  assert.equal(done, true);
});

test('paused: a queue waits, and resume releases it', async () => {
  resetPauseBus();
  const end = beginQueue();
  setPaused(true);
  let released = false;
  const waiting = whenResumed().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false, 'nothing new starts while paused');
  setPaused(false);
  await waiting;
  assert.equal(released, true);
  end();
});

test('the pause clears itself when the last queue ends, so the next week is not silently stopped', () => {
  resetPauseBus();
  const seen: Array<[boolean, number]> = [];
  subscribePause(() => seen.push([isPaused(), queuesRunning()]));
  const end = beginQueue();
  setPaused(true);
  assert.deepEqual(seen.at(-1), [true, 1]);
  end();
  assert.equal(isPaused(), false);
  assert.equal(queuesRunning(), 0);
  end(); // twice is harmless
  assert.equal(queuesRunning(), 0);
});

test('the badge shows Pause while a queue runs, and the queue asks before every post and every picture', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const badge = src('components/LoadingScreen.tsx');
  assert.match(badge, /pause\.queues > 0 && \(/, 'the button appears only while a queue runs');
  assert.match(badge, /\{paused \? 'Resume' : 'Pause'\}/);
  assert.match(badge, /pointer-events-auto/, 'the badge itself lets clicks through; the button must not');
  const panel = src('components/StrategyDrop.tsx');
  assert.match(panel, /const endQueue = beginQueue\(\);/);
  assert.match(panel, /await whenResumed\(\);\s*const sl = pending\[i\+\+\];/, 'asked before each post');
  assert.match(panel, /if \(made\.draftId && picturesRef\.current && !isPaused\(\)\)/, 'and before each picture');
});

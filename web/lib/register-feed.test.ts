import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegisterFeed } from './register-feed.ts';

const at = (m: number) => new Date(Date.UTC(2026, 8, 16, 12, m)).toISOString();

test('a run line can never crowd out what actually happened', () => {
  // THE REGRESSION. The sweep writes a line every fifteen minutes, so a window
  // of forty entries was ten quiet hours of nothing but run lines, and the
  // panel that says what arrived could only say that a sweep had run.
  const activity = [{ event: 'first_seen', createdAt: at(10) }, { event: 'prepared', createdAt: at(5) }];
  const runs = Array.from({ length: 40 }, (_, i) => ({ event: 'sweep_ran', createdAt: at(59 - i) }));
  const feed = mergeRegisterFeed(activity, runs);
  assert.equal(feed.filter((e) => e.event === 'sweep_ran').length, 1);
  assert.equal(feed.filter((e) => e.event !== 'sweep_ran').length, 2);
});

test('only the latest run is kept, and everything is newest first', () => {
  const feed = mergeRegisterFeed(
    [{ event: 'queued', createdAt: at(30) }, { event: 'failed', createdAt: at(50) }],
    [{ event: 'sweep_ran', createdAt: at(20) }, { event: 'sweep_ran', createdAt: at(40) }],
  );
  assert.deepEqual(feed.map((e) => e.event), ['failed', 'sweep_ran', 'queued']);
  assert.deepEqual(feed.map((e) => e.createdAt), [at(50), at(40), at(30)]);
});

test('no runs, or no activity, each stand alone', () => {
  assert.deepEqual(mergeRegisterFeed([{ event: 'prepared', createdAt: at(1) }], []).map((e) => e.event), ['prepared']);
  assert.deepEqual(mergeRegisterFeed([], [{ event: 'sweep_ran', createdAt: at(1) }]).map((e) => e.event), ['sweep_ran']);
  assert.deepEqual(mergeRegisterFeed([], []), []);
});

test('an entry with no usable timestamp sorts last instead of scrambling the order', () => {
  const feed = mergeRegisterFeed(
    [{ event: 'broken', createdAt: '' }, { event: 'prepared', createdAt: at(10) }],
    [{ event: 'sweep_ran', createdAt: at(5) }],
  );
  assert.deepEqual(feed.map((e) => e.event), ['prepared', 'sweep_ran', 'broken']);
});

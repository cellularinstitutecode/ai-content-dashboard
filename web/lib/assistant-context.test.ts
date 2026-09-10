import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greetingFor, renderSnapshot, situationOf, summarise, type RunRow } from './assistant-context.ts';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('a live claim is being worked on; a dead one is retryable', () => {
  assert.equal(situationOf({ state: 'preparing', updated_at: ago(60_000) }, NOW), 'working');
  // The case that stayed invisible: nothing is holding this claim.
  assert.equal(situationOf({ state: 'preparing', updated_at: ago(60 * 60_000) }, NOW), 'retryable');
});

test('the failure code decides who has to act', () => {
  assert.equal(situationOf({ state: 'failed', last_error_code: 'out_of_time' }, NOW), 'retryable');
  assert.equal(situationOf({ state: 'failed', last_error_code: 'named_a_person' }, NOW), 'needs_you');
  assert.equal(situationOf({ state: 'failed', last_error_code: 'transcript_not_kept' }, NOW), 'blocked');
  assert.equal(situationOf({ state: 'prepared' }, NOW), 'done');
  assert.equal(situationOf({ state: 'discovered' }, NOW), 'waiting');
});

test('problems are named, healthy rows are only counted', () => {
  const rows: RunRow[] = [
    { state: 'prepared', video_title: 'Done one' },
    { state: 'failed', video_title: 'Timed out', row_number: 180, last_error_code: 'out_of_time', last_error: 'Ran out of time.' },
    { state: 'discovered', video_title: 'Queued' },
  ];
  const s = summarise(rows, NOW);
  assert.equal(s.counts.done, 1);
  assert.equal(s.counts.waiting, 1);
  assert.equal(s.counts.retryable, 1);
  assert.equal(s.problems.length, 1);
  assert.equal(s.problems[0].title, 'Timed out');
});

test('the rows a person must act on are named before the ones we can fix', () => {
  const rows: RunRow[] = [
    { state: 'failed', video_title: 'Temporary', last_error_code: 'out_of_time' },
    { state: 'failed', video_title: 'Needs a human', last_error_code: 'no_transcript' },
    { state: 'failed', video_title: 'Migration', last_error_code: 'transcript_not_kept' },
  ];
  const s = summarise(rows, NOW);
  assert.deepEqual(s.problems.map((p) => p.title), ['Migration', 'Needs a human', 'Temporary']);
});

test('the named list is capped so a big backlog costs the same as a small one', () => {
  const rows: RunRow[] = Array.from({ length: 40 }, (_, i) => ({
    state: 'failed', video_title: 'Video ' + i, last_error_code: 'out_of_time',
  }));
  const s = summarise(rows, NOW);
  assert.equal(s.counts.retryable, 40);
  assert.equal(s.problems.length, 3);
  assert.ok(renderSnapshot(s).split('\n').length < 12);
});

test('a very long sheet title is trimmed rather than pasted whole', () => {
  const s = summarise([{ state: 'failed', video_title: 'x'.repeat(300), last_error_code: 'out_of_time' }], NOW);
  assert.ok(s.problems[0].title.length <= 60);
});

test('the failure’s own sentence is preferred over the category', () => {
  const s = summarise([{ state: 'failed', video_title: 'V', last_error_code: 'no_transcript', last_error: 'Only a few words could be heard.' }], NOW);
  assert.equal(s.problems[0].plain, 'Only a few words could be heard.');
});

test('a broken dependency is said first, and nothing impossible is offered', () => {
  const s = summarise([{ state: 'failed', last_error_code: 'out_of_time' }], NOW, {
    health: [{ down: 'Writing is unavailable — no AI is connected.' }],
  });
  const g = greetingFor(s);
  assert.match(g.message, /no AI is connected/);
  assert.ok(!g.chips.some((c) => /retry/i.test(c)));
});

test('the greeting names what is stuck and offers to fix it', () => {
  const s = summarise([
    { state: 'failed', video_title: 'Hydrogen reel', row_number: 180, last_error_code: 'out_of_time', last_error: 'Ran out of time.' },
  ], NOW);
  const g = greetingFor(s);
  assert.match(g.message, /Hydrogen reel/);
  assert.match(g.message, /row 180/);
  assert.deepEqual(g.chips[0], 'Retry that one');
  // The promise that must survive every rewording of this file.
  assert.match(g.message, /nothing goes to Metricool without you saying so/i);
});

test('several stuck videos offer one action, not one per row', () => {
  const rows: RunRow[] = [
    { state: 'failed', video_title: 'A', last_error_code: 'out_of_time' },
    { state: 'failed', video_title: 'B', last_error_code: 'generation_failed' },
  ];
  assert.equal(greetingFor(summarise(rows, NOW)).chips[0], 'Retry everything that is stuck');
});

test('an all-clear pipeline does not invent work', () => {
  const g = greetingFor(summarise([{ state: 'prepared' }], NOW));
  assert.match(g.message, /done or moving/);
  assert.ok(!g.chips.some((c) => /retry/i.test(c)));
});

test('an account that has never swept is told that, not "all clear"', () => {
  const g = greetingFor(summarise([], NOW));
  assert.match(g.message, /Nothing has been through/);
});

test('a missing Brand Brain is surfaced, because it blocks Metricool later', () => {
  const s = summarise([{ state: 'prepared' }], NOW, { hasBrandProfile: false });
  assert.match(renderSnapshot(s), /No Brand Brain/);
});

test('overnight recovery is reported only when something actually moved', () => {
  const quiet = summarise([{ state: 'prepared' }], NOW, { recovery: { revived: 0, released: 0 } });
  assert.equal(quiet.recovery, null);
  assert.ok(!renderSnapshot(quiet).includes('Since the last pass'));

  const busy = summarise([{ state: 'prepared' }], NOW, { recovery: { revived: 2, released: 1 } });
  assert.match(renderSnapshot(busy), /Since the last pass: 2 retried/);
});

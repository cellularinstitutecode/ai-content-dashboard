import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVE_MS, remainingMs, downloadBudgetMs, transcribeBudgetMs, canWriteCopy, streamExtractBudgetMs, COMFORTABLE_COPY_MS } from './prepare-budget.ts';

test('remaining counts down from the start of the request', () => {
  assert.equal(remainingMs(1_000, 300_000, 1_000), 300_000);
  assert.equal(remainingMs(1_000, 300_000, 61_000), 240_000);
});

test('remaining goes negative once the clock is overrun', () => {
  assert.equal(remainingMs(0, 60_000, 70_000), -10_000);
});

test('the download only gets what is left after the steps that follow it', () => {
  // 300s function, nothing spent yet: 300 - 25 - 60 = 215.
  assert.equal(downloadBudgetMs(300_000), 215_000);
});

test('a request with too little left never starts the download', () => {
  // The 60-second case that was being killed mid-transfer: it should refuse
  // up front instead, because 60 - 25 - 60 leaves nothing to download into.
  assert.ok(downloadBudgetMs(60_000) <= 0);
  assert.ok(downloadBudgetMs(90_000) > 0);
});

test('the transcriber is capped at its reserve however much time is spare', () => {
  assert.equal(transcribeBudgetMs(300_000), RESERVE_MS.transcribe);
});

test('a slow download shrinks the transcriber rather than the copy', () => {
  // 100s left: copy keeps its 60, so the transcriber gets 40, not 60.
  assert.equal(transcribeBudgetMs(100_000), 40_000);
});

test('the transcriber is never handed a negative budget', () => {
  assert.equal(transcribeBudgetMs(10_000), 0);
  assert.equal(transcribeBudgetMs(-5_000), 0);
});

test('copy is written only when there is time to write it unhurried', () => {
  // This asserted RESERVE_MS.copy until the two questions were separated. That
  // constant is the FLOOR transcription must leave behind; the threshold for
  // starting to write here rather than handing off is its own number, and
  // conflating them is what let a 60-second remainder look like enough.
  assert.equal(canWriteCopy(COMFORTABLE_COPY_MS), true);
  assert.equal(canWriteCopy(COMFORTABLE_COPY_MS - 1), false);
  assert.equal(canWriteCopy(RESERVE_MS.copy), false, 'the floor alone is not enough to press on');
  assert.equal(canWriteCopy(-1), false);
});

test('streaming straight off a URL is not charged for an extraction it never does', () => {
  // The disk path transfers, then extracts; the streaming path decodes as the
  // bytes arrive. Reserving for both took 25 seconds off the only path that is
  // ever used by files big enough to need them.
  const remaining = 200_000;
  assert.equal(streamExtractBudgetMs(remaining), remaining - RESERVE_MS.transcribe);
  assert.ok(streamExtractBudgetMs(remaining) > downloadBudgetMs(remaining));
  assert.equal(streamExtractBudgetMs(remaining) - downloadBudgetMs(remaining), RESERVE_MS.extract);
});

test('a slow download hands off to a fresh clock instead of hurrying the writer', () => {
  // The whole point. lib/prepare-request.ts already asks a second time when the
  // server answers 202 'transcript_ready', and that second request starts with
  // the full clock and a cached transcript. Pressing on with a minute is the
  // wrong trade whenever handing off is available.
  assert.equal(canWriteCopy(60_000), false, 'a minute is not enough to press on');
  assert.equal(canWriteCopy(COMFORTABLE_COPY_MS), true);
  assert.equal(canWriteCopy(COMFORTABLE_COPY_MS - 1), false);
});

test('a normal reel still finishes in one pass', () => {
  // 76-283 MB downloads in seconds, so the writer starts with minutes in hand
  // and nothing about the hand-off applies. This must not become two requests
  // for every video.
  assert.equal(canWriteCopy(260_000), true);
});

test('the comfort threshold does not starve transcription', () => {
  // Raising RESERVE_MS.copy itself would have done exactly that: the run would
  // die BEFORE the transcript was banked, keeping nothing, which is worse than
  // the failure being fixed.
  assert.ok(COMFORTABLE_COPY_MS > RESERVE_MS.copy, 'they are different questions');
  assert.equal(transcribeBudgetMs(200_000), RESERVE_MS.transcribe, 'unchanged by the new threshold');
  assert.ok(transcribeBudgetMs(100_000) > 0, 'a tight clock still gets to transcribe');
});

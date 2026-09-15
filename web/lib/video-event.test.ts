// The register's wording and identity rules, which are the parts worth pinning
// down without a database. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerEntry, describeEntry, videoKeyFor, driveVideoKey, VIDEO_EVENTS } from './video-event.ts';

const base = { userId: 'u1', videoKey: 'sheet|Tab|abc', event: 'prepared' };

test('a key is stable against rows moving, because rowKey already is', () => {
  // The same row, seen after somebody inserted three rows above it.
  assert.equal(videoKeyFor('sheet1', 'Enero', 'title::link'), videoKeyFor('sheet1', 'Enero', 'title::link'));
  // Different tab is a different video, even with identical content.
  assert.notEqual(videoKeyFor('sheet1', 'Enero', 'k'), videoKeyFor('sheet1', 'Febrero', 'k'));
  assert.notEqual(videoKeyFor('sheet1', 'Enero', 'k'), driveVideoKey('k'));
});

test('whitespace around the parts does not create a second identity', () => {
  assert.equal(videoKeyFor(' sheet1 ', 'Enero ', ' k'), videoKeyFor('sheet1', 'Enero', 'k'));
});

test('an unrecognised event is recorded as something rather than dropped', () => {
  // A register that refuses a row it does not know records nothing, and a
  // partial record beats no record.
  const e = registerEntry({ ...base, event: 'invented_later' });
  assert.ok(VIDEO_EVENTS.includes(e.event));
  assert.equal(e.actor, 'unknown', 'an unnamed actor is unknown, never guessed');
});

test('every declared event survives the round trip', () => {
  for (const ev of VIDEO_EVENTS) {
    assert.equal(registerEntry({ ...base, event: ev }).event, ev);
  }
});

test('null and undefined details are dropped, not stored as nulls', () => {
  const e = registerEntry({ ...base, detail: { error: null, reason: undefined, attempts: 0, ok: false } });
  assert.deepEqual(Object.keys(e.detail).sort(), ['attempts', 'ok']);
  assert.equal(e.detail.attempts, 0, 'zero is a value, not an absence');
  assert.equal(e.detail.ok, false, 'false is a value, not an absence');
});

test('numbers and booleans stay typed so the register can be queried', () => {
  const e = registerEntry({ ...base, detail: { attempts: 3, degraded: true } });
  assert.equal(typeof e.detail.attempts, 'number');
  assert.equal(typeof e.detail.degraded, 'boolean');
});

test('one enormous error cannot bloat the register', () => {
  const e = registerEntry({ ...base, title: 'x'.repeat(5000), detail: { error: 'y'.repeat(9000) } });
  assert.ok((e.title as string).length <= 300);
  assert.ok(String(e.detail.error).length <= 2000);
  assert.match(e.title as string, /…$/, 'a clipped value says it was clipped');
});

test('an empty title is null rather than an empty string', () => {
  const e = registerEntry({ ...base, title: '   ', link: '' });
  assert.equal(e.title, null);
  assert.equal(e.link, null);
});

// --- the wording ------------------------------------------------------------

test('the moment the register exists for reads as an arrival', () => {
  assert.match(describeEntry({ event: 'first_seen', actor: 'sweep' }), /Added to the sheet/);
});

test('a failed copy says what it COSTS, not just that it failed', () => {
  const said = describeEntry({ event: 'copy_failed', actor: 'button', detail: { error: 'The folder is not in a Shared Drive.' } });
  assert.match(said, /no video/, 'the consequence is the part a person acts on');
  assert.match(said, /Shared Drive/, 'and the reason travels with it');
});

test('a queued event names the networks it reached', () => {
  assert.match(describeEntry({ event: 'queued', detail: { networks: ['youtube', 'tiktok'] } }), /youtube, tiktok/);
});

test('queued always says a person still approves', () => {
  assert.match(describeEntry({ event: 'queued', detail: {} }), /awaiting approval/i);
  assert.doesNotMatch(describeEntry({ event: 'queued', detail: {} }), /published|live/i);
});

test('the mechanism is named in words, never as a column value', () => {
  assert.match(describeEntry({ event: 'retried', actor: 'assistant' }), /the assistant/);
  assert.match(describeEntry({ event: 'retried', actor: 'revive' }), /automatic retry/);
  assert.doesNotMatch(describeEntry({ event: 'retried', actor: 'revive' }), /revive/);
});

test('an unknown actor still produces a sentence', () => {
  const said = describeEntry({ event: 'prepared', actor: 'something-else' });
  assert.ok(said.length > 0);
  assert.match(said, /something/);
});

test('every event has wording — none falls through to the raw name', () => {
  for (const ev of VIDEO_EVENTS) {
    const said = describeEntry({ event: ev, actor: 'sweep', detail: {} });
    assert.ok(said.length > 0, ev);
    assert.doesNotMatch(said, new RegExp('^' + ev.replace(/_/g, ' ')), ev + ' has no wording of its own');
  }
});

// --- the sweep reports itself --------------------------------------------------
import { SWEEP_KEY } from './video-event.ts';

test('a sweep_ran line says what the run saw and did', () => {
  assert.ok((VIDEO_EVENTS as readonly string[]).includes('sweep_ran'));
  assert.equal(registerEntry({ userId: 'u', videoKey: SWEEP_KEY, event: 'sweep_ran', actor: 'sweep' }).event, 'sweep_ran');
  const said = describeEntry({
    event: 'sweep_ran', actor: 'sweep',
    detail: { scanned: 302, hidden: 178, belowStart: 0, startRow: 179, queuedExisting: 20, prepared: 0, needsTranscript: 19, failed: 0, stoppedEarly: true },
  });
  assert.equal(said, 'Sweep ran: 302 rows seen · 178 hidden · 0 below row 179 · 20 queued with copy · 0 prepared · 19 need a transcript · 0 failed · stopped early.');
  assert.match(describeEntry({ event: 'sweep_ran', detail: { dryRun: true, scanned: 5 } }), /^Dry run: 5 rows seen/);
});

test('a sweep that stopped says why, and never reads as a video', () => {
  assert.equal(describeEntry({ event: 'sweep_ran', detail: { error: 'The posting calendar could not be read.' } }), 'Sweep stopped: The posting calendar could not be read.');
  assert.ok(SWEEP_KEY.startsWith('sweep|'));
});

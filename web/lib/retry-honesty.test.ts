// Retry must not report success when it did nothing.
//
// advanceRuns had EIGHT paths that skipped a run and still let the caller
// answer { ok: true, advanced: 0 } — a shape indistinguishable from a quiet
// day. The worst is a switched-off template, where Retry is a PERMANENT no-op
// that reports success every single time it is pressed, writes no log line, and
// leaves the red card exactly where it was. That alone explains a card
// surviving a week of retries.
//
// Source checks, because advanceRuns imports `server-only` and cannot run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const engine = readFileSync(new URL('./autopilot.ts', import.meta.url), 'utf8');
const route = readFileSync(new URL('../app/api/autopilot/runs/route.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../app/AutopilotQueue.tsx', import.meta.url), 'utf8');

test('advanceRuns reports why it stood down', () => {
  assert.match(engine, /skipped: string\[\]/, 'the return type carries no reasons');
  assert.match(engine, /return \{ advanced, ready, errors, skipped \}/, 'the reasons are computed and then dropped');
});

test('the switched-off template — the permanent no-op — says so by name', () => {
  // It must name the template and point at where to turn it back on, because
  // this is the case a reviewer cannot possibly diagnose from a red card.
  assert.match(engine, /strategy\.mode === 'off' \|\| !template\.active/);
  const at = engine.indexOf("strategy.mode === 'off' || !template.active");
  const after = engine.slice(at, at + 600);
  assert.match(after, /skip\(/, 'the off-template skip is still silent');
  assert.match(after, /Templates/, 'it never says where to turn the template back on');
});

test('a Retry that moved nothing is not answered with ok', () => {
  // Both button paths: Retry (run_now) and Ask-for-changes (regenerate).
  const notAdvanced = route.match(/if \(!result\.advanced && result\.skipped\.length\)/g) || [];
  assert.equal(notAdvanced.length, 2, 'run_now and regenerate must both refuse to claim success');
  assert.match(route, /error: 'not_advanced'/);
  assert.match(route, /status: 409/);
});

test('the queue shows the sentence, not the machine code', () => {
  // The route answers { error: 'not_advanced', message: '…' }. Reading `error`
  // alone put the bare token `not_advanced` in front of a person and threw away
  // the sentence written for them.
  assert.match(queue, /j\?\.message \|\| j\?\.error/, 'the handler still prefers the machine code');
});

test('the engine caps how much it will explain', () => {
  // A 50-run tick must not return an essay.
  assert.match(engine, /skipped\.length < 10/);
});

// web/lib/variety-wiring.test.ts
// Phase 3's engine lines. lib/autopilot.ts imports `server-only`, so these are
// source checks on the lines that carry the dealt variety to the writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const autopilot = src('lib/autopilot.ts');

test('stepResearch deals the variety from the same week as the angle, and remembers the last opening', () => {
  assert.match(autopilot, /varietyFor\(strategy\.slot, dealt\.week\)/);
  assert.match(autopilot, /previousOpeningFor\(run, seedTopic\)/);
});

test('the writer is given the format, reader and closing', () => {
  for (const k of ['formatBrief', 'audienceBrief', 'closingBrief']) assert.match(autopilot, new RegExp(k + ': varietyBriefs'));
  assert.match(autopilot, /audience: audienceOf\(angle\)/);
});

test('stepScore checks openings against what was published and rewrites a repeat', () => {
  assert.match(autopilot, /recentOpenings: recentOpeners/);
  assert.match(autopilot, /Boolean\(score\.openingRepeat\)/);
});

test('the review card shows the format and reader', () => {
  assert.match(src('app/AutopilotQueue.tsx'), /varietyLabels\(r\.angle\)/);
});

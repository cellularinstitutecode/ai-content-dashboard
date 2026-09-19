// web/lib/angle-repeat.test.ts
//
// The two anti-repeat wirings inside lib/autopilot.ts, which imports
// `server-only` and cannot be loaded by the test runner — which is exactly why
// both of these sat broken in plain sight. Source checks, then, on the lines
// that have to agree with each other.
//
// The rule they enforce: the column stepResearch READS must be the column both
// draft-writing branches WRITE. It has now been the wrong column on each of
// them in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the reader and both writers name the same column', () => {
  const autopilot = src('lib/autopilot.ts');

  // The reader: the anti-repeat set is built from `topic`.
  assert.match(
    autopilot,
    /from\('draft_keywords'\)\s*\n?\s*\.select\('topic'\)/,
    'stepResearch must still read the topic column'
  );

  // The cache-only writer. It wrote `angle.seedTopic` — the pillar name — into
  // the column the reader compares `angle.query` against, so nothing written in
  // cache-only mode was ever matched and that branch's anti-repeat did nothing.
  const insert = autopilot.slice(autopilot.indexOf("from('draft_keywords').insert({"));
  assert.ok(insert, 'the cache-only insert is gone — has this moved?');
  const topicLine = insert.slice(0, insert.indexOf('})')).match(/topic:\s*([^,\n]+)/);
  assert.ok(topicLine, 'the insert no longer sets topic');
  assert.equal(topicLine![1].trim(), 'angle.query', 'the cache-only branch must write the query, not the pillar');
});

test('the template carries its own history into the decision', () => {
  const autopilot = src('lib/autopilot.ts');

  // Read from the table that has been recording it all along...
  assert.match(autopilot, /from\('template_runs'\)\s*\n?\s*\.select\('angle, scheduled_for'\)/);
  assert.match(autopilot, /\.lt\('scheduled_for', run\.scheduled_for\)/, 'only occurrences BEFORE this one');
  assert.match(autopilot, /\.limit\(ANGLE_HISTORY\)/, 'and capped, so an old template keeps its bank');

  // ...and handed to the chooser, which is where the rule and its tests live.
  assert.match(autopilot, /chooseAngle\(available, occurrenceIndex, history\)/);
  assert.match(autopilot, /decideAngle\([^)]*angleHistory\)/s, 'the history must actually reach decideAngle');
});

test('the opening-line window is derived from the cadence', () => {
  const openers = src('lib/recent-openers.ts');
  assert.match(openers, /const LOOK_BACK = openingLookBack\(\)/, 'no hand-typed number here again');
  assert.doesNotMatch(openers, /const LOOK_BACK = \d+/, 'a literal would drift the moment the calendar changes');
});

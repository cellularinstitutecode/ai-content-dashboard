// Autopilot could fail on every tick, forever, with nobody the wiser: the
// engine writes template_runs and reads schedule_templates.strategy, both
// created by a .sql file a human is asked to paste into the Supabase SQL
// editor. When that had not been run, every tick errored where nothing was
// watching, the queue stayed empty, and /api/health — which only ever read
// environment variables — reported a healthy deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_SCHEMA, isMissingSchema, schemaDetail, MISSING_TABLE, MISSING_COLUMN,
} from './schema-probe.ts';

test('only a missing table or column means a migration was skipped', () => {
  assert.equal(isMissingSchema(MISSING_TABLE), true);
  assert.equal(isMissingSchema(MISSING_COLUMN), true);
  // These are the ones that matter to get wrong. A permissions error or a
  // dropped connection is not evidence that anybody forgot to run SQL, and
  // reporting it as such sends a person to run a migration that was fine.
  assert.equal(isMissingSchema('42501'), false, 'insufficient_privilege is not a missing migration');
  assert.equal(isMissingSchema('PGRST301'), false, 'an expired JWT is not a missing migration');
  assert.equal(isMissingSchema('08006'), false, 'a connection failure is not a missing migration');
  assert.equal(isMissingSchema(undefined), false);
  assert.equal(isMissingSchema(null), false);
});

test('a healthy database says so without naming a file', () => {
  const said = schemaDetail([]);
  assert.doesNotMatch(said, /\.sql/);
  assert.match(said, /present/i);
});

test('the detail names the file to run, not just the thing that is missing', () => {
  // "template_runs is missing" leaves the reader with nowhere to go.
  const said = schemaDetail(REQUIRED_SCHEMA.filter((p) => p.table === 'template_runs'));
  assert.match(said, /template_runs/);
  assert.match(said, /supabase\/autopilot\.sql/);
  assert.match(said, /Autopilot/);
  assert.doesNotMatch(said, /template_runs\./, 'a missing TABLE must not be named as a column');
});

test('a missing column is named as a column, not as a table', () => {
  // schedule_templates.strategy is an ALTER TABLE. A database can have the
  // table and still be missing the column, and "schedule_templates is
  // missing" would send someone looking for a table that is right there.
  const said = schemaDetail(REQUIRED_SCHEMA.filter((p) => p.column === 'strategy'));
  assert.match(said, /schedule_templates\.strategy/);
});

test('two gaps in one file ask for that file once', () => {
  const said = schemaDetail(REQUIRED_SCHEMA.filter((p) => p.file === 'supabase/autopilot.sql'));
  assert.equal(said.match(/supabase\/autopilot\.sql/g)?.length, 1);
  assert.match(said, /are missing/);
});

test('gaps across two files ask for both', () => {
  const said = schemaDetail(REQUIRED_SCHEMA);
  assert.match(said, /supabase\/autopilot\.sql/);
  assert.match(said, /supabase\/schema\.sql/);
});

test('every probe carries a file and a consequence', () => {
  // A probe with no file is a dead end for whoever reads the banner.
  for (const p of REQUIRED_SCHEMA) {
    assert.match(p.file, /^supabase\/.+\.sql$/, p.table + ' has no migration file');
    assert.ok(p.breaks.length > 3, p.table + ' does not say what breaks');
    assert.ok(p.kind === 'table' || p.kind === 'column', p.table + ' has no probe kind');
    assert.ok(p.column, p.table + ' has no column to probe');
  }
});

test('the Autopilot objects that actually broke are both covered', () => {
  const covered = REQUIRED_SCHEMA.map((p) => p.table + '.' + p.column);
  assert.ok(covered.includes('template_runs.id'));
  assert.ok(covered.includes('schedule_templates.strategy'));
});

test('a missing table is named as a table and a missing column as a column', () => {
  // Getting this backwards sends the reader hunting for the wrong object:
  // a column inside a table that is not there, or a table that is.
  const both = schemaDetail(REQUIRED_SCHEMA.filter((p) => p.file === 'supabase/autopilot.sql'));
  assert.match(both, /template_runs,/, 'the missing table should be named bare');
  assert.doesNotMatch(both, /template_runs\.id/);
  assert.match(both, /schedule_templates\.strategy/, 'the missing column should carry its table');
});

test('one subject broken twice is said once', () => {
  // template_runs and schedule_templates.strategy both break Autopilot.
  // "breaks Autopilot; Autopilot" is how a useful sentence turns into noise.
  const said = schemaDetail(REQUIRED_SCHEMA.filter((p) => p.file === 'supabase/autopilot.sql'));
  assert.equal(said.match(/Autopilot/g)?.length, 1);
});

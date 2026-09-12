// The assistant used to see one health check out of seventeen, so with the
// Drive copies folder unusable it opened with "Everything in the video pipeline
// is either done or moving" while the banner on the same screen said no video
// could be attached to any post. These are about that. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthNotes } from './health-notes.ts';
import { plainFor } from './health-plain.ts';

const ok = (name: string) => ({ name, ok: true, severity: 'required' as const });

test('a healthy deployment says nothing at all', () => {
  assert.deepEqual(healthNotes([ok('supabase'), ok('drive_storage'), ok('semrush')]), []);
});

test('the folder that is not a Shared Drive blocks video, and says which folder', () => {
  const notes = healthNotes([
    { name: 'drive_storage', ok: false, severity: 'required', code: 'not_shared_drive' },
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].blocksVideos, true, 'this is the check that decides whether ANY video can be attached');
  assert.match(notes[0].down, /Shared Drive/);
  assert.ok(notes[0].stillWorks, 'a person must not read this as a total outage');
});

// The reason code changes who has to act, and the narrowed entries in the map
// were unreachable until plainFor learned to compose "name:code".
test('the reason code picks the narrower sentence', () => {
  const vague = healthNotes([{ name: 'drive_storage', ok: false, severity: 'required' }])[0];
  const specific = healthNotes([{ name: 'drive_storage', ok: false, severity: 'required', code: 'not_shared_drive' }])[0];
  assert.notEqual(vague.down, specific.down, 'a coded failure must not produce the generic wording');
  assert.match(specific.down, /not in a Shared Drive/);
});

test('a degraded extra is reported but never as a video blocker', () => {
  const notes = healthNotes([{ name: 'semrush', ok: false, severity: 'optional', code: 'budget' }]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].blocksVideos, false);
  assert.match(notes[0].down, /credit balance/, 'an empty wallet is nobody’s connection problem');
});

// greetingFor returns on the FIRST blocking note and says nothing else, so the
// order here decides which single sentence a person reads.
test('the most upstream cause is named first', () => {
  const notes = healthNotes([
    { name: 'drive_storage', ok: false, severity: 'required', code: 'not_shared_drive' },
    { name: 'semrush', ok: false, severity: 'optional', code: 'no_token' },
    { name: 'supabase', ok: false, severity: 'required' },
  ]);
  assert.match(notes[0].down, /sign-in/i, 'no database means nothing else is worth saying');
  assert.equal(notes[notes.length - 1].blocksVideos, false, 'degraded extras come last');
});

test('drive and drive_storage do not both say the same thing', () => {
  const notes = healthNotes([
    { name: 'drive', ok: false, severity: 'optional', code: 'no_folder' },
    { name: 'drive_storage', ok: false, severity: 'required', code: 'unreachable' },
  ]);
  assert.equal(notes.length, 1, 'DRIVE_FOLDER_ID unset fails both; the specific one wins');
  assert.match(notes[0].down, /cannot be opened/);
});

// The probe knows exactly which migration file is missing; flattened to "ask
// whoever set this up to run the migration" it loses the only actionable part.
test('the schema check is left to the caller, which composes it from the probe', () => {
  assert.deepEqual(healthNotes([{ name: 'database_schema', ok: false, severity: 'required', code: 'migration_pending' }]), []);
});

test('an unknown check still produces a sentence rather than crashing', () => {
  const notes = healthNotes([{ name: 'some_future_check', ok: false, severity: 'optional' }]);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].down.length > 0);
  assert.equal(notes[0].blocksVideos, false, 'unknown must fail towards the quieter claim');
});

test('every check name the map knows still resolves through healthNotes', () => {
  // Guards against a rename on one side only: the check is renamed in
  // lib/health-checks.ts, the map keeps the old key, and the note silently
  // degrades to "some check is not available."
  const said = plainFor('sweep_owner');
  const note = healthNotes([{ name: 'sweep_owner', ok: false, severity: 'required' }])[0];
  assert.equal(note.down, said.down);
  assert.equal(note.blocksVideos, true);
});

// --- what may silence the greeting -------------------------------------------
//
// greetingFor returns on the FIRST blocking note and says nothing else, so a
// wrong `true` buys silence about everything behind it.

test('a read-only sheet does not silence "no video can be attached"', () => {
  // Both failing. sheet_write used to be classified blocking AND sorted ahead of
  // drive_storage, so the greeting said "the copy cannot be written back into
  // the Google Sheet — videos are still transcribed" and never mentioned that no
  // video could reach any network.
  const notes = healthNotes([
    { name: 'sheet_write', ok: false, severity: 'required', code: 'read_only' },
    { name: 'drive_storage', ok: false, severity: 'required', code: 'not_shared_drive' },
  ]);
  const firstBlocking = notes.find((n) => n.blocksVideos);
  assert.ok(firstBlocking, 'something must still be blocking');
  assert.match(firstBlocking!.down, /Shared Drive/, 'the total block outranks the partial one');
});

test('a degradation does not silence the rest of the greeting', () => {
  for (const name of ['drive', 'audio_extractor', 'semrush', 'metricool', 'images']) {
    const note = healthNotes([{ name, ok: false, severity: 'required' }])[0];
    assert.equal(note.blocksVideos, false, name + ' must not take the headline');
  }
});

test('the checks that stop the pipeline are blocking', () => {
  for (const name of ['supabase', 'supabase_service_role', 'sweep_owner', 'ai_provider', 'drive_storage', 'sheet_write']) {
    const note = healthNotes([{ name, ok: false, severity: 'required' }])[0];
    assert.equal(note.blocksVideos, true, name + ' must reach the greeting headline');
  }
});

// sheet_write is blocking so it is always REPORTED — greetingFor's aside prints
// health[0] alone, so a non-blocking note can be hidden behind any other note —
// but it must not outrank the check that says no video reaches any network.
test('sheet_write is reportable without outranking drive_storage', () => {
  const alone = healthNotes([{ name: 'sheet_write', ok: false, severity: 'required', code: 'read_only' }]);
  assert.equal(alone[0].blocksVideos, true, 'on its own it must still be said');

  const both = healthNotes([
    { name: 'sheet_write', ok: false, severity: 'required', code: 'read_only' },
    { name: 'drive_storage', ok: false, severity: 'required', code: 'not_shared_drive' },
  ]);
  assert.match(both[0].down, /Shared Drive/, 'the stronger claim takes the headline');
});

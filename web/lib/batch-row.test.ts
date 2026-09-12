import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postRowFor } from './batch-row.ts';

const base = { userId: 'u1', provider: 'instagram', text: 'hello', instant: '2026-10-01T15:00:00.000Z' };

// The bug that shipped. publication_date is timestamptz; a bare wall-clock
// string is parsed as UTC, so a 09:00 Cancún post was stored as 09:00 UTC —
// 04:00 Cancún — and the calendar and Metricool disagreed by five hours.
test('the stored date is the same moment Metricool was given', () => {
  const row = postRowFor(base);
  assert.equal(Date.parse(row.publication_date), Date.parse(base.instant));
});

test('the stored date carries a zone, so it cannot be read as local', () => {
  const row = postRowFor(base);
  assert.match(row.publication_date, /Z$|[+-]\d{2}:?\d{2}$/,
    'a value with no offset is ambiguous and Postgres resolves it to UTC');
});

test('a post is never recorded as approved', () => {
  // Metricool answers "scheduled" for a post it is merely holding for review.
  assert.equal(postRowFor(base).status, 'pending_review');
  assert.equal(postRowFor({ ...base, metricoolId: 'abc' }).status, 'pending_review');
});

test('a missing Metricool id is null, not undefined', () => {
  assert.equal(postRowFor(base).metricool_post_id, null);
  assert.equal(postRowFor({ ...base, metricoolId: 'x1' }).metricool_post_id, 'x1');
});

// /api/posts PATCH rebuilds media from draft_id, then media_drive_file_id, and
// nothing else. A row with neither publishes the edit with no media at all.
test('a post records the draft it came from', () => {
  assert.equal(postRowFor({ ...base, draftId: 'd1' }).draft_id, 'd1');
});

test('absent links are omitted rather than written as null', () => {
  const row = postRowFor(base);
  assert.ok(!('draft_id' in row), 'a null draft_id would overwrite nothing but reads as a deliberate unlink');
  // Empty strings are absent too — a blank id is not a link.
  assert.ok(!('draft_id' in postRowFor({ ...base, draftId: '' })));
});

// media_drive_file_id means "the id of the copy THIS APP made", and /api/posts
// DELETE passes it to deleteDriveFile. The batch path has no such id — only one
// parsed out of a model-supplied URL — so writing it would put a link to a
// publicly-shared ORIGINAL on the delete path for the clinic's own footage.
test('a batch row never claims to own a Drive file', () => {
  for (const row of [postRowFor(base), postRowFor({ ...base, draftId: 'd1' })]) {
    assert.ok(!('media_drive_file_id' in row), 'the batch path cannot know a copy id, so it must not assert one');
  }
});

test('the provider is always a list, because the column is', () => {
  assert.deepEqual(postRowFor(base).providers, ['instagram']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicatePosts, identityOf } from './duplicate-posts.ts';

const row179 = { spreadsheetId: 'S', tab: '2026 CELLULAR HOPE', row: 179 };

test('the same row on the same network more than once: keep the earliest, list the rest', () => {
  const posts = [
    { id: 'a', providers: ['linkedin'], status: 'pending_review', created_at: '2026-09-15T15:13:00Z', source: row179 },
    { id: 'b', providers: ['linkedin'], status: 'pending_review', created_at: '2026-09-15T08:45:00Z', source: row179 },
    { id: 'c', providers: ['linkedin'], status: 'pending_review', created_at: '2026-09-15T15:06:00Z', source: row179 },
    { id: 'd', providers: ['tiktok'], status: 'pending_review', created_at: '2026-09-15T08:45:00Z', source: row179 },
  ];
  const out = findDuplicatePosts(posts);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].keep.id, 'b');
  assert.deepEqual(out.groups[0].extras.map((p) => p.id), ['c', 'a']);
  assert.deepEqual(out.extras.map((p) => p.id), ['c', 'a']);
});

test('approved or published copies are not counted; different networks are not duplicates', () => {
  const posts = [
    { id: 'a', providers: ['linkedin'], status: 'approved', source: row179 },
    { id: 'b', providers: ['linkedin'], status: 'pending_review', source: row179 },
    { id: 'c', providers: ['youtube'], status: 'pending_review', source: row179 },
  ];
  assert.equal(findDuplicatePosts(posts).extras.length, 0);
});

test('without a row, the video copy, then the draft, then the text identify a post', () => {
  assert.equal(identityOf({ id: 1, source: row179, media_drive_file_id: 'c' }), 'row:S|2026 CELLULAR HOPE|179');
  assert.equal(identityOf({ id: 1, media_drive_file_id: 'copy1', draft_id: 'd' }), 'copy:copy1');
  assert.equal(identityOf({ id: 1, draft_id: 'd' }), 'draft:d');
  assert.equal(identityOf({ id: 1, text: '  Quality   in regenerative ' }), 'text:quality in regenerative');
  assert.equal(identityOf({ id: 1 }), '');
  const posts = [
    { id: 'a', providers: ['linkedin'], status: 'pending_review', text: 'Same words', created_at: '2026-09-15T10:00:00Z' },
    { id: 'b', providers: ['linkedin'], status: 'pending_review', text: 'same  words ', created_at: '2026-09-15T11:00:00Z' },
  ];
  const out = findDuplicatePosts(posts);
  assert.equal(out.groups[0].keep.id, 'a');
  assert.deepEqual(out.extras.map((p) => p.id), ['b']);
});

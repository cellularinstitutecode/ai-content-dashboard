import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvableGroups, approvalSummary, groupPostsByVideo, postsToApprove } from './video-board.ts';

const awaiting = (s: unknown) => s === 'pending_review';
const approved = (s: unknown) => s === 'approved';
const posts = [
  { id: 'a1', status: 'pending_review', providers: ['youtube'], publication_date: '2026-09-16T14:00:00Z', text: 'Video A copy', draft_id: 'dA', videoPending: false, source: { tab: 'Marzo', row: 180, gid: 5, title: 'A' } },
  { id: 'a2', status: 'pending_review', providers: ['tiktok'], publication_date: '2026-09-16T14:00:00Z', text: 'Video A copy', draft_id: 'dA', videoPending: false, source: { tab: 'Marzo', row: 180, gid: 5, title: 'A' } },
  { id: 'a3', status: 'approved', providers: ['linkedin'], publication_date: '2026-09-16T14:00:00Z', text: 'Video A copy', draft_id: 'dA', videoPending: false, source: { tab: 'Marzo', row: 180, gid: 5, title: 'A' } },
  { id: 'b1', status: 'pending_review', providers: ['youtube'], publication_date: '2026-09-15T22:00:00Z', text: 'Video B copy\nsecond line', draft_id: 'dB', videoPending: true, source: null },
  { id: 'c1', status: 'pending_review', providers: ['linkedin'], publication_date: '2026-09-17T14:00:00Z', text: 'No draft', draft_id: null, videoPending: false, source: { tab: 'Marzo', row: 190, gid: 5, title: null } },
];

test('posts are grouped by video, earliest first, with what a person needs to decide', () => {
  const groups = groupPostsByVideo(posts, awaiting, approved);
  assert.deepEqual(groups.map((g) => g.key), ['draft:dB', 'draft:dA', 'row:Marzo:190']);
  const a = groups[1];
  assert.equal(a.title, 'A');
  assert.equal(a.posts.length, 3);
  assert.equal(a.awaiting.length, 2);
  assert.equal(a.approved, 1);
  assert.equal(a.pendingVideo, false);
  assert.equal(a.source?.row, 180);
  const b = groups[0];
  assert.equal(b.title, 'Video B copy');
  assert.equal(b.pendingVideo, true);
});

test('only videos with something waiting AND the video in place are approvable', () => {
  const groups = groupPostsByVideo(posts, awaiting, approved);
  assert.deepEqual(approvableGroups(groups).map((g) => g.key), ['draft:dA', 'row:Marzo:190']);
});

test('a batch approval sends exactly the waiting posts of the selected, approvable videos', () => {
  const groups = groupPostsByVideo(posts, awaiting, approved);
  const ids = postsToApprove(groups, new Set(['draft:dA', 'draft:dB', 'row:Marzo:190'])).map((p) => p.id);
  // a3 is already approved; b1 is waiting for its video — neither is sent.
  assert.deepEqual(ids, ['a1', 'a2', 'c1']);
  assert.deepEqual(postsToApprove(groups, new Set()), []);
});

test('the confirmation says what will happen, in plain words', () => {
  assert.match(approvalSummary(2, 5, false), /^Approve 2 videos \(5 posts\)\? Each goes out at its scheduled time/);
  assert.match(approvalSummary(1, 1, true), /^Publish 1 video now \(1 post\)\? They go out in the next couple of minutes/);
});

test('junk is ignored', () => {
  assert.deepEqual(groupPostsByVideo(null, awaiting, approved), []);
  assert.deepEqual(groupPostsByVideo([{ id: '' }], awaiting, approved), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPlanFor, pendingPosts, postsByRow } from './attach-plan.ts';

const L = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view';

test('a row with posts waiting for their video is attached to', () => {
  assert.equal(attachPlanFor({ link: L, copy: 'x' }, [{ id: 'a', videoPending: true }, { id: 'b', videoPending: false }]), 'attach');
  assert.deepEqual(pendingPosts([{ id: 'a', videoPending: true }, { id: 'b', videoPending: false }]).map((p) => p.id), ['a']);
});

test('a row whose posts all carry the video is done — no call is made', () => {
  assert.equal(attachPlanFor({ link: L, copy: 'x' }, [{ id: 'a', videoPending: false }, { id: 'b' }]), 'done');
});

test('a row with no posts is queued when its copy is written, prepared when it is not', () => {
  assert.equal(attachPlanFor({ link: L, copy: 'written' }, []), 'queue');
  assert.equal(attachPlanFor({ link: L, copy: 'written' }, null), 'queue');
  assert.equal(attachPlanFor({ link: L, copy: '' }, []), 'prepare');
  assert.equal(attachPlanFor({ link: L, copy: '   ' }, undefined), 'prepare');
});

test('a row with no video has nothing to attach, whatever else it has', () => {
  assert.equal(attachPlanFor({ link: '', copy: 'x' }, [{ id: 'a', videoPending: true }]), 'no_video');
});

test('posts are grouped by the sheet row they came from; posts with no source are left out', () => {
  const grouped = postsByRow([
    { id: 'a', videoPending: true, source: { tab: 'Marzo', row: 179 } },
    { id: 'b', videoPending: false, source: { tab: 'Marzo', row: 179 } },
    { id: 'c', videoPending: true, source: { tab: 'Marzo', row: 180 } },
    { id: 'd', videoPending: true, source: null },
    { id: 'e', videoPending: true },
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ['Marzo:179', 'Marzo:180']);
  assert.deepEqual(grouped.get('Marzo:179')!.map((p) => p.id), ['a', 'b']);
});

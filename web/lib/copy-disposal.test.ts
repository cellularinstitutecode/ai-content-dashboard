import test from 'node:test';
import assert from 'node:assert/strict';
import { disposalFor, type CopyWhere } from './copy-disposal.ts';

test('a streamed video has nothing to delete', () => {
  // THE REGRESSION GUARD. Nothing was created for a streamed video: the id on
  // the post names the clinic's ORIGINAL footage. If this ever answers
  // anything but 'none', a failed verification deletes the master.
  assert.equal(disposalFor('stream'), 'none');
});

test('the other two are removed where they live', () => {
  assert.equal(disposalFor('bucket'), 'bucket');
  assert.equal(disposalFor('drive'), 'drive');
});

test('a video uploaded into Metricool is theirs: nothing here is deleted for it', () => {
  // The recorded id carries no Drive file id and no bucket key — see
  // lib/metricool-upload-parse.ts. There is nothing of ours to remove.
  assert.equal(disposalFor('metricool'), 'none');
});

test('every case is named — there is no default branch to fall into', () => {
  const all: CopyWhere[] = ['bucket', 'stream', 'drive', 'metricool'];
  for (const w of all) assert.ok(['bucket', 'drive', 'none'].includes(disposalFor(w)), w);
  // An unlisted value is a type error at build time and undefined here, which
  // is the point: it is not silently treated as a Drive file.
  assert.equal(disposalFor('something-new' as CopyWhere), undefined);
});

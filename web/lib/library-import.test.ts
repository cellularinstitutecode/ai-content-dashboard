import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LIBRARY_IMPORT_MAX_BYTES, busyLabel, sizeLabel, tileNote, tooLargeToImport } from './library-import.ts';

const MB = 1048576;

test('the browser refuses at the same ceiling the server does', () => {
  const google = readFileSync(new URL('./google-sources.ts', import.meta.url), 'utf8');
  assert.equal(LIBRARY_IMPORT_MAX_BYTES, 200 * MB);
  assert.match(google, /export const LIBRARY_IMAGE_MAX_BYTES = 200 \* 1024 \* 1024;/);
  assert.equal(tooLargeToImport(200 * MB), false);
  assert.equal(tooLargeToImport(200 * MB + 1), true);
  // Drive omits the size for some files; the server still checks those.
  assert.equal(tooLargeToImport(null), false);
});

test('a small photo stays quiet; a big one says how big', () => {
  assert.equal(tileNote(2 * MB), '');
  assert.equal(tileNote(null), '');
  assert.equal(tileNote(45 * MB), '45 MB');
  assert.equal(tileNote(230 * MB), 'Too large (230 MB, max 200 MB)');
  assert.equal(sizeLabel(3.24 * MB), '3.2 MB');
  assert.equal(sizeLabel(0), '');
});

test('while copying: the verb alone for a small photo, size and seconds for a big one', () => {
  assert.equal(busyLabel('Copying', 2 * MB, 5), 'Copying…');
  assert.equal(busyLabel('Copying', null, 5), 'Copying…');
  assert.equal(busyLabel('Copying', 45 * MB, 0), 'Copying 45 MB…');
  assert.equal(busyLabel('Attaching', 150 * MB, 12.7), 'Attaching 150 MB… 12 s');
});

test('all three pickers use it', () => {
  for (const f of ['HeroImageControls', 'HeroImagePicker', 'SourcesView']) {
    const src = readFileSync(new URL('../components/' + f + '.tsx', import.meta.url), 'utf8');
    assert.match(src, /tooLargeToImport\(img\.size\)/, f + ' disables a photo over the ceiling');
    assert.match(src, /<ImportingLabel /, f + ' shows the copy as it runs');
  }
});

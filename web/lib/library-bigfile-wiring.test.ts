// The folder's best photography is 30-45 MB camera exports. #320 taught the
// captioner to scale a picture down before it looked at it, but the ceiling
// that decided whether a file was read at all lived one layer lower, in
// downloadDriveFile, and refused anything over 25 MB before a single byte
// was fetched. The downscaler never saw those files. 50 of 175 photographs
// were invisible to the library for that reason alone.
//
// These are source assertions because the routes talk to Drive and OpenAI
// and cannot be loaded by the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const google = readFileSync(new URL('./google-sources.ts', import.meta.url), 'utf8');
const caption = readFileSync(new URL('../app/api/sources/caption/route.ts', import.meta.url), 'utf8');
const palette = readFileSync(new URL('../app/api/sources/palette/route.ts', import.meta.url), 'utf8');

test('the size ceiling is a parameter, not a literal buried in the reader', () => {
  assert.match(google, /export const DRIVE_FILE_MAX_BYTES = 25 \* 1024 \* 1024;/);
  assert.match(google, /maxBytes: number = DRIVE_FILE_MAX_BYTES/);
  assert.match(google, /Number\(meta\.size\) > maxBytes/);
});

test('no literal 25 MB comparison survives in the reader', () => {
  const guard = google.slice(google.indexOf('export async function downloadDriveFile'));
  assert.doesNotMatch(guard.slice(0, 1200), /meta\.size\) > 25 \* 1024 \* 1024/);
});

test('the routes that scale the picture down raise the ceiling', () => {
  for (const [name, src] of [['caption', caption], ['palette', palette]] as const) {
    assert.match(src, /const BIG_FILE_MAX_BYTES = 64 \* 1024 \* 1024;/, name + ' sets a bigger ceiling');
    assert.match(src, /downloadDriveFile\([^)]*BIG_FILE_MAX_BYTES\)/, name + ' passes it');
  }
});

test('the captioner still scales before it looks, and still refuses the absurd', () => {
  assert.match(caption, /smallJpeg\(file\.bytes/);
  assert.match(caption, /skipped: 'too_large'/);
});

test('the ceiling stays 25 MB for callers that did not opt in', () => {
  const imports = readFileSync(new URL('../app/api/sources/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(imports, /downloadDriveFile\([^)]*BIG_FILE_MAX_BYTES/);
});

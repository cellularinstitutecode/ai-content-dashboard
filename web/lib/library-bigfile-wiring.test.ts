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
// The captioner moved out of the route into the index (lib/library-index.ts): the route now only reports and remembers.
const caption = readFileSync(new URL('./library-index.ts', import.meta.url), 'utf8');
const palette = readFileSync(new URL('../app/api/sources/palette/route.ts', import.meta.url), 'utf8');

const imports = readFileSync(new URL('../app/api/sources/route.ts', import.meta.url), 'utf8');
const downscale = readFileSync(new URL('./image-downscale.ts', import.meta.url), 'utf8');
const reader = google.slice(google.indexOf('export async function downloadDriveFileToDisk'));

test('the Library ceiling is 200 MB, one constant for all three routes', () => {
  // 500 MB was asked for and 200 MB settled on: the platform's /tmp is about
  // 512 MB, and the download and ffmpeg's output share it.
  assert.match(google, /export const LIBRARY_IMAGE_MAX_BYTES = 200 \* 1024 \* 1024;/);
  for (const [name, src] of [['import_image', imports], ['caption', caption], ['palette', palette]] as const) {
    assert.match(src, /downloadDriveFileToDisk\([^)]*LIBRARY_IMAGE_MAX_BYTES\)/, name + ' passes it');
    assert.doesNotMatch(src, /BIG_FILE_MAX_BYTES|64 \* 1024 \* 1024/, name + ' keeps no ceiling of its own');
    assert.doesNotMatch(src, /downloadDriveFile\(/, name + ' does not hold the file in memory');
    assert.match(src, /cleanup\b/, name + ' deletes the file');
  }
});

test('the file is streamed to disk and counted, never buffered whole', () => {
  assert.match(reader, /Number\(meta\.size\) > maxBytes/);
  assert.match(reader, /pipeline\(Readable\.fromWeb\(res\.body/);
  assert.match(reader, /createWriteStream\(file\)/);
  // Drive omits the size for some files, so the bytes are counted as they come.
  assert.match(reader, /size > maxBytes \? tooBig\(\)/);
  assert.doesNotMatch(reader.slice(0, reader.indexOf('\n}\n')), /arrayBuffer\(\)/);
  // One timer for the WHOLE body (gfetch's own is cleared once headers land).
  assert.match(reader, /\{ signal: ctl\.signal \}/);
  // And the file is removed when anything goes wrong.
  assert.match(reader, /catch \(e\) \{\s*await cleanup\(\);/);
});

test('the helpers read the picture from disk', () => {
  assert.match(downscale, /export async function fitImage\(input: string, size: number/);
  assert.doesNotMatch(downscale, /writeFile/);
  // An original too big to store is not read into memory to be refused.
  assert.match(downscale, /size > FIT_ORIGINAL_MAX_BYTES \? refused\(\)/);
  assert.match(caption, /smallJpeg\(file\.path\)/);
  assert.match(palette, /measureImage\(file\.path\)/);
});

test('the captioner still scales before it looks, and still refuses the absurd', () => {
  assert.match(caption, /if \(!small && file\.size > 12 \* 1024 \* 1024\) \{ report\.skipped \+= 1; continue; \}/);
});

test('import_image scales the picture down and refuses what it could not shrink', () => {
  assert.match(imports, /fitImage\(file\.path, file\.size/);
  // The resizer's binary is fetched while the photo downloads, not after.
  assert.ok(imports.indexOf('void resolveFfmpeg()') > 0 && imports.indexOf('void resolveFfmpeg()') < imports.indexOf('downloadDriveFileToDisk(body.fileId'));
  assert.match(imports, /if \(!fit\.bytes\)/);
  assert.match(imports, /'That image is larger than ' \+ Math\.round\(LIBRARY_IMAGE_MAX_BYTES/);
  assert.doesNotMatch(imports, /larger than (25|64) MB/);
  assert.match(imports, /export const maxDuration = 300;/);
});

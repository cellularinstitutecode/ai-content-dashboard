// web/lib/palette-wiring.test.ts
// The measure helper and the triage route talk to ffmpeg, Drive and Supabase,
// so the test runner cannot load them. These are source checks on the wiring —
// the same gap that let a no-op ship in the image route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const measure = readFileSync(new URL('./palette-measure.ts', import.meta.url), 'utf8');
const route = readFileSync(new URL('../app/api/sources/palette/route.ts', import.meta.url), 'utf8');

test('the picture is scaled down before its pixels are counted', () => {
  assert.match(measure, /'scale=64:-1'/);
  assert.match(measure, /'-pix_fmt', 'rgb24'/);
});

test('measuring never throws — an unreadable file is null, not an exception', () => {
  assert.match(measure, /catch \{\s*return null;/);
  assert.match(measure, /finally \{/, 'the temp directory is always cleaned up');
});

test('the triage route is read-only', () => {
  assert.doesNotMatch(route, /storeBytes|uploadFolderImage|appendRow|updateRowCells/,
    'measuring must not import, store or write anything');
  assert.doesNotMatch(route, /export async function POST/);
  assert.match(route, /export async function GET/);
});

test('the triage route is behind the same gate as the rest of sources', () => {
  assert.match(route, /requireAllowlistedUser/);
  assert.match(route, /status: 403/);
});

test('one bad photograph does not fail the whole pass', () => {
  assert.match(route, /verdict: 'unreadable'/);
});

const caption = readFileSync(new URL('../app/api/sources/caption/route.ts', import.meta.url), 'utf8');

test('the caption route is read-only too', () => {
  assert.doesNotMatch(caption, /storeBytes|uploadFolderImage|appendRow|updateRowCells/);
  assert.doesNotMatch(caption, /export async function POST/);
  assert.match(caption, /requireAllowlistedUser/);
});

test('captioning asks for the small image, not the 30 MB original', () => {
  assert.match(caption, /detail: 'low'/);
  assert.match(caption, /skipped: 'too_large'/, 'an oversized file is reported, not silently dropped');
});

const small = readFileSync(new URL('./image-small.ts', import.meta.url), 'utf8');
const measure2 = readFileSync(new URL('./palette-measure.ts', import.meta.url), 'utf8');

test('a 30 MB camera export is scaled, not skipped', () => {
  assert.match(caption, /smallJpeg/);
  assert.doesNotMatch(caption, /if \(file\.bytes\.length > 12 \* 1024 \* 1024\) \{\s*rows\.push/,
    'the size check must come after the downscale attempt, not instead of it');
});

test('both passes allow long enough for a large decode', () => {
  assert.match(small, /timeout: 90_000/);
  assert.match(measure2, /timeout: 90_000/);
});

test('downscaling fails soft — the caller keeps the original bytes', () => {
  assert.match(small, /catch \{\s*return null;/);
  assert.match(small, /finally \{/);
});

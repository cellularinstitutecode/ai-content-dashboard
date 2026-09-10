import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSOLUTE_MAX_BYTES, DISK_SAFE_BYTES, megabytes, routeFor } from './media-route.ts';

const MB = 1024 * 1024;

test('the videos the clinic normally posts keep the proven path', () => {
  // 76-283 MB, per the range recorded in lib/google-sources.ts.
  assert.equal(routeFor(76 * MB), 'disk');
  assert.equal(routeFor(283 * MB), 'disk');
  assert.equal(routeFor(DISK_SAFE_BYTES), 'disk', 'exactly at the cap still fits');
});

test('the file that prompted this is streamed rather than refused', () => {
  // 1722 MB — 3.4x the entire scratch disk, so raising the old number could
  // never have helped.
  assert.equal(routeFor(1722 * MB), 'stream');
  assert.equal(routeFor(DISK_SAFE_BYTES + 1), 'stream');
});

test('an unknown size keeps the guarded path, not the unguarded one', () => {
  // Drive omits `size` for shortcuts. The disk path refuses mid-download if the
  // bytes overrun; the URL path has no ceiling to refuse against.
  assert.equal(routeFor(null), 'disk');
  assert.equal(routeFor(Number.NaN), 'disk');
});

test('past the absolute ceiling it is refused, with the size to say so', () => {
  assert.equal(routeFor(ABSOLUTE_MAX_BYTES + 1), 'too_large');
  assert.equal(routeFor(ABSOLUTE_MAX_BYTES), 'stream', 'the ceiling itself is allowed');
  assert.equal(megabytes(1722 * MB), '1722 MB');
  assert.equal(megabytes(null), 'that video');
});

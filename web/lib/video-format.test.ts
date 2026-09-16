import test from 'node:test';
import assert from 'node:assert/strict';
import { isLandscapeFormat, isVerticalFormat } from './video-format.ts';

test('the clinic’s FORMATO wordings are read as vertical', () => {
  for (const f of ['Vertical 9:16', 'vertical', '9x16', '9 / 16', 'Reel', 'Shorts', 'Story', 'portrait', 'Retrato']) {
    assert.equal(isVerticalFormat(f), true, f);
    assert.equal(isLandscapeFormat(f), false, f);
  }
});

test('landscape wordings are read as landscape', () => {
  for (const f of ['Horizontal 16:9', 'landscape', 'Paisaje', '16x9']) {
    assert.equal(isLandscapeFormat(f), true, f);
    assert.equal(isVerticalFormat(f), false, f);
  }
});

test('an empty or unknown cell is neither', () => {
  for (const f of ['', null, undefined, 'Cuadrado', 'video']) {
    assert.equal(isVerticalFormat(f), false);
    assert.equal(isLandscapeFormat(f), false);
  }
});

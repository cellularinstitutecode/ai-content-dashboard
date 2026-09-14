import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  clampZoom, frameGeometry, readStoredZoom, zoomIn, zoomLabel, zoomOut, zoomStorageKey,
} from './sheet-zoom.ts';

test('the default is 100% and the range is sensible', () => {
  assert.equal(ZOOM_DEFAULT, 1);
  assert.ok(ZOOM_MIN < 1 && ZOOM_MAX > 1);
  assert.ok(ZOOM_STEP > 0 && ZOOM_STEP < 0.5);
});

test('anything unreadable becomes the default, anything out of range is clamped', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, 0, -1, {}]) {
    assert.equal(clampZoom(bad), 1, JSON.stringify(bad) + ' should fall back to 100%');
  }
  assert.equal(clampZoom(10), ZOOM_MAX);
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom('0.8'), 0.8);
});

test('zooming in and out steps by the step and stops at the ends', () => {
  assert.equal(zoomIn(1), 1.1);
  assert.equal(zoomOut(1), 0.9);
  // A value below the floor is clamped first, then stepped.
  assert.equal(clampZoom(0.1), ZOOM_MIN);
  assert.equal(zoomIn(0.1), 0.6);
  // Floating point does not leak into the value: 0.7 + 0.1 is 0.8, not 0.7999999.
  assert.equal(zoomIn(0.7), 0.8);
  assert.equal(zoomIn(ZOOM_MAX), ZOOM_MAX);
  assert.equal(zoomOut(ZOOM_MIN), ZOOM_MIN);
  let z = 1;
  for (let i = 0; i < 10; i++) z = zoomIn(z);
  assert.equal(z, ZOOM_MAX);
});

test('the label is a whole percent', () => {
  assert.equal(zoomLabel(1), '100%');
  assert.equal(zoomLabel(0.8), '80%');
  assert.equal(zoomLabel(zoomIn(zoomIn(1))), '120%');
});

test('at 100% the frame is drawn exactly at the box size', () => {
  assert.deepEqual(frameGeometry(1, 760), { widthPercent: 100, height: 760, transform: 'scale(1)' });
});

test('zoomed out, the frame is drawn larger and shrunk; zoomed in, smaller and enlarged', () => {
  const out = frameGeometry(0.5, 800);
  assert.equal(out.widthPercent, 200);
  assert.equal(out.height, 1600);
  assert.equal(out.transform, 'scale(0.5)');
  const inn = frameGeometry(1.25, 800);
  assert.equal(inn.widthPercent, 80);
  assert.equal(inn.height, 640);
  assert.equal(inn.transform, 'scale(1.25)');
});

test('the drawn size times the scale always fills the box', () => {
  for (const z of [0.5, 0.7, 1, 1.3, 1.5]) {
    const g = frameGeometry(z, 900);
    assert.ok(Math.abs(g.widthPercent * z - 100) < 0.5, 'width at ' + z);
    assert.ok(Math.abs(g.height * z - 900) < 1, 'height at ' + z);
  }
});

test('a remembered zoom is read back safely, keyed per sheet', () => {
  assert.equal(readStoredZoom('0.9'), 0.9);
  assert.equal(readStoredZoom('garbage'), 1);
  assert.equal(readStoredZoom(null), 1);
  assert.equal(zoomStorageKey('abc'), 'chi:sheet-zoom:abc');
  assert.notEqual(zoomStorageKey('a'), zoomStorageKey('b'));
});

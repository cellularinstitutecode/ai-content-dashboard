// Which band of a picture is quiet, and which side of it. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandDetail, quietBand, quietSide } from './cover-bands.ts';

const W = 40, H = 60;
const SKIN: [number, number, number] = [224, 172, 140];
const WALL: [number, number, number] = [180, 176, 170];
/** A 40×60 picture painted by a rule: 'skin', 'busy' (a coarse checkerboard) or plain wall. */
function picture(at: (x: number, y: number) => 'skin' | 'busy' | 'wall'): Uint8Array {
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = at(x, y);
    const px: [number, number, number] = k === 'skin' ? SKIN : k === 'busy' ? ((((x >> 1) + (y >> 1)) % 2) ? [230, 230, 230] : [30, 30, 30]) : WALL;
    rgb.set(px, (y * W + x) * 3);
  }
  return rgb;
}

test('a plain ceiling over a crowd: the top is the quiet band; a crowd over a plain floor: the bottom', () => {
  const crowdBelow = bandDetail(picture((_x, y) => (y > 24 ? 'busy' : 'wall')), W, H);
  assert.ok(crowdBelow.top.detail < crowdBelow.bottom.detail * 0.2, JSON.stringify(crowdBelow));
  assert.equal(quietBand(crowdBelow), 'top');
  assert.equal(quietBand(bandDetail(picture((_x, y) => (y < 36 ? 'busy' : 'wall')), W, H)), 'bottom');
});

test('a face in a band loses it, however plain the rest of that band is', () => {
  // A face top-right on an otherwise plain wall; a busy table at the bottom.
  const d = bandDetail(picture((x, y) => (y < 12 && x > 28 ? 'skin' : y > 36 ? 'busy' : 'wall')), W, H);
  assert.ok(d.top.skin > 0.02 && d.bottom.skin === 0, JSON.stringify(d));
  assert.equal(quietBand(d), 'bottom', 'the band with the face is avoided even though it has less detail');
});

test('within a band, the half with the person loses; two plain halves decide nothing', () => {
  const standingRight = bandDetail(picture((x, _y) => (x > 24 ? 'skin' : 'wall')), W, H);
  assert.equal(quietSide(standingRight, 'bottom'), 'left');
  assert.equal(quietSide(standingRight, 'top'), 'left');
  const plain = bandDetail(picture(() => 'wall'), W, H);
  assert.equal(quietSide(plain, 'bottom'), null);
  assert.equal(quietBand(plain), null);
  assert.equal(quietBand(null), null);
  assert.equal(quietSide(null, 'top'), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_TARGET, GRADE_LIMITS, gradeFor, paletteDistance, statsFromRgb } from './palette.ts';

const rgb = (triples: number[][]) => Uint8Array.from(triples.flat());

test('stats are read straight off a raw rgb24 buffer', () => {
  const s = statsFromRgb(rgb([[255, 0, 0], [0, 0, 255]]));
  assert.equal(s.r, 127.5);
  assert.equal(s.b, 127.5);
  assert.equal(s.warm, 0, 'one red and one blue pixel average to no cast');
  assert.equal(s.sat, 100, 'both are fully saturated');
});

test('a flat grey has no cast and no colour', () => {
  const s = statsFromRgb(rgb([[128, 128, 128], [128, 128, 128]]));
  assert.equal(s.warm, 0);
  assert.equal(s.sat, 0);
  assert.equal(s.lum, 128);
});

test('an empty buffer does not throw', () => {
  assert.deepEqual(statsFromRgb(new Uint8Array(0)), { r: 0, g: 0, b: 0, warm: 0, sat: 0, lum: 0 });
});

test('the target measures zero distance from itself', () => {
  assert.equal(paletteDistance(BRAND_TARGET), 0);
  assert.equal(gradeFor(BRAND_TARGET).verdict, 'ready');
});

test('a cool fluorescent clinic photo is graded, not refused', () => {
  // Blue-grey cast, a little dark, ordinary saturation — the common case.
  const s = { r: 138, g: 142, b: 150, warm: -12, sat: 30, lum: 140 };
  const g = gradeFor(s);
  assert.equal(g.verdict, 'grade');
  assert.equal(g.filters.length, 2);
  // Warming it means lifting red and pulling blue down.
  const cb = g.filters[0];
  assert.match(cb, /^colorbalance=rm=0\.\d+:gm=0:bm=-0\.\d+$/, cb);
  // And easing the phone's contrast while lifting exposure.
  assert.match(g.filters[1], /contrast=0\.940/);
  assert.match(g.filters[1], /brightness=0\.0\d+/);
});

test('the magenta LED therapy room is refused rather than pushed', () => {
  const s = { r: 150, g: 90, b: 160, warm: -10, sat: 62, lum: 110 };
  const g = gradeFor(s);
  assert.equal(g.verdict, 'outside');
  assert.match(g.reason, /saturated|coloured light/i);
  assert.deepEqual(g.filters, []);
});

test('the near-black corridor is refused as too dark to lift', () => {
  const s = { r: 40, g: 42, b: 48, warm: -8, sat: 20, lum: 42 };
  const g = gradeFor(s);
  assert.equal(g.verdict, 'outside');
  assert.match(g.reason, /too dark/i);
});

test('a warm tungsten room is cooled, not refused', () => {
  const s = { r: 200, g: 150, b: 100, warm: 100, sat: 35, lum: 160 };
  const g = gradeFor(s);
  assert.equal(g.verdict, 'grade');
  // Cooling means pulling red down and blue up — the opposite of the fluorescent case.
  assert.match(g.filters[0], /rm=-0\.\d+:gm=0:bm=0\.\d+/);
});

test('a cast beyond anything a real room produces is refused', () => {
  assert.equal(gradeFor({ r: 230, g: 120, b: 60, warm: 170, sat: 40, lum: 165 }).verdict, 'outside');
});

test('a photo already close to the palette is left alone', () => {
  const s = { ...BRAND_TARGET, warm: 30, sat: 26, lum: 153 };
  const g = gradeFor(s);
  assert.equal(g.verdict, 'ready');
  assert.deepEqual(g.filters, []);
});

test('every correction the grader emits stays inside the stated limits', () => {
  // Sweep the whole space a real photo can occupy; nothing may produce a gain
  // beyond the cap, and nothing may produce NaN.
  for (let warm = -40; warm <= 75; warm += 5) {
    for (let sat = 5; sat <= 45; sat += 5) {
      for (let lum = 100; lum <= 215; lum += 15) {
        const g = gradeFor({ r: 0, g: 0, b: 0, warm, sat, lum });
        assert.ok(['ready', 'grade', 'outside'].includes(g.verdict));
        for (const f of g.filters) {
          assert.doesNotMatch(f, /NaN|Infinity/, f);
          for (const [, v] of f.matchAll(/=(-?\d+\.\d+)/g)) {
            assert.ok(Math.abs(Number(v)) <= 1.7, `${f} — ${v} is out of range`);
          }
        }
      }
    }
  }
});

test('distance weighs the three measures comparably', () => {
  const one = (k: 'warm' | 'sat' | 'lum') => paletteDistance({ ...BRAND_TARGET, [k]: BRAND_TARGET[k] + GRADE_LIMITS[k] });
  assert.equal(one('warm'), 1);
  assert.equal(one('sat'), 1);
  assert.equal(one('lum'), 1);
});

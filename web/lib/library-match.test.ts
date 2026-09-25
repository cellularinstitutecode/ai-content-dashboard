import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverage, pickForPillar, type Candidate } from './library-match.ts';
import { BRAND_TARGET } from './palette.ts';
import { parseCaption } from './library-caption.ts';

const inPalette = { ...BRAND_TARGET };
const gradeable = { r: 138, g: 142, b: 150, warm: -12, sat: 30, lum: 140 };
const magenta = { r: 150, g: 90, b: 160, warm: -10, sat: 62, lum: 110 };

const cand = (id: string, subjects: string[], opts: Partial<Candidate> & { blockers?: string[] } = {}): Candidate => ({
  id,
  name: id + '.png',
  caption: parseCaption({ caption: 'a picture', subjects, blockers: opts.blockers ?? [] })!,
  stats: 'stats' in opts ? opts.stats : inPalette,
  consentCleared: opts.consentCleared,
});

test('a consultation is offered for the pillars it serves', () => {
  const m = pickForPillar([cand('a', ['consultation'])], 'diagnosis');
  assert.ok(m);
  assert.equal(m!.id, 'a');
  assert.match(m!.why, /already in the palette/);
});

test('nothing is offered for a pillar the folder cannot serve', () => {
  // The finding this module exists for: 22 consultations do not make a
  // nutrition cover, and offering one would be worse than generating.
  const clinical = ['a', 'b', 'c'].map((id) => cand(id, ['consultation']));
  for (const pillar of ['nutrition', 'sleep', 'movement', 'stress', 'practical-nutrition']) {
    assert.equal(pickForPillar(clinical, pillar), null, pillar);
  }
});

test('a picture the cover rules refuse is never offered', () => {
  for (const blocker of ['text', 'procedure', 'device-on-person', 'render']) {
    assert.equal(pickForPillar([cand('x', ['consultation'], { blockers: [blocker] })], 'diagnosis'), null, blocker);
  }
});

test('a recognisable patient waits for a release', () => {
  const shot = cand('p', ['consultation'], { blockers: ['identifiable-patient'] });
  assert.equal(pickForPillar([shot], 'diagnosis'), null, 'no release recorded');
  assert.ok(pickForPillar([{ ...shot, consentCleared: true }], 'diagnosis'), 'release recorded');
});

test('an unmeasured picture is passed over, not assumed fine', () => {
  assert.equal(pickForPillar([cand('u', ['consultation'], { stats: null })], 'diagnosis'), null);
});

test('a picture too far from the palette is passed over', () => {
  assert.equal(pickForPillar([cand('m', ['treatment-room'], { stats: magenta })], 'recovery'), null);
});

test('a focused picture beats a scattered one, and an in-palette one beats a graded one', () => {
  const focused = cand('food', ['food']);                       // serves 3 pillars
  const scattered = cand('mixed', ['consultation', 'portrait', 'team']);
  assert.equal(pickForPillar([scattered, focused], 'supplementation')!.id, 'food');

  const ready = cand('ready', ['consultation']);
  const needsWork = cand('cool', ['consultation'], { stats: gradeable });
  assert.equal(pickForPillar([needsWork, ready], 'diagnosis')!.id, 'ready');
});

test('a picture needing a grade still carries its filters', () => {
  const m = pickForPillar([cand('cool', ['consultation'], { stats: gradeable })], 'diagnosis');
  assert.ok(m);
  assert.equal(m!.filters.length, 2);
  assert.match(m!.why, /graded into the palette/);
});

test('coverage names the pillars that need photographs taken, not code', () => {
  const folder = [
    cand('c1', ['consultation']), cand('c2', ['consultation']), cand('t1', ['treatment-room']),
    cand('r1', ['reception']), cand('f1', ['food']),
    cand('x1', ['procedure'], { blockers: ['procedure'] }),
    cand('x2', ['rest'], { blockers: ['text'] }),        // the only sleep photo, refused
  ];
  const { served, empty } = coverage(folder, ['diagnosis', 'nutrition', 'sleep', 'movement', 'recovery']);
  assert.ok(served.diagnosis >= 2);
  assert.equal(served.nutrition, 1);
  assert.equal(served.sleep, 0, 'the one rest photo has signage in it');
  assert.equal(served.movement, 0);
  assert.deepEqual(empty, ['sleep', 'movement']);
});

test('an empty folder offers nothing and claims nothing', () => {
  assert.equal(pickForPillar([], 'diagnosis'), null);
  const { empty } = coverage([], ['diagnosis', 'sleep']);
  assert.deepEqual(empty, ['diagnosis', 'sleep']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKERS, SUBJECTS, captionSystemPrompt, coverSafe, inventory, parseCaption, pillarsFor } from './library-caption.ts';
import { PILLARS } from './content-strategy.ts';

const cap = (subjects: string[], blockers: string[] = []) =>
  parseCaption({ caption: 'a picture', subjects, blockers })!;

test('a well-formed answer parses, and unknown words are dropped rather than trusted', () => {
  const c = parseCaption({ caption: '  A clinician and a patient  talking at a desk. ', subjects: ['consultation', 'nonsense', 'portrait'], blockers: ['text', 'aliens'] })!;
  assert.equal(c.caption, 'A clinician and a patient talking at a desk.');
  assert.deepEqual(c.subjects, ['consultation', 'portrait']);
  assert.deepEqual(c.blockers, ['text']);
});

test('a JSON answer wrapped in prose still parses', () => {
  const c = parseCaption('Sure! ```json\n{"caption":"An IV chair.","subjects":["iv-suite"],"blockers":[]}\n``` hope that helps');
  assert.equal(c?.subjects[0], 'iv-suite');
});

test('an answer with no subject is unusable', () => {
  assert.equal(parseCaption({ caption: 'something', subjects: [], blockers: [] }), null);
  assert.equal(parseCaption({ caption: '', subjects: ['portrait'] }), null);
  assert.equal(parseCaption('not json at all'), null);
});

test('duplicates are collapsed and the subject list is capped', () => {
  const c = cap(['portrait', 'portrait', 'team', 'exterior', 'lab', 'food']);
  assert.equal(c.subjects.length, 3);
  assert.equal(new Set(c.subjects).size, 3);
});

test('every subject maps to pillars that exist in the strategy', () => {
  const ids = new Set(PILLARS.map((p) => p.id));
  for (const s of SUBJECTS) {
    for (const p of pillarsFor({ subjects: [s] })) {
      assert.ok(ids.has(p), `${s} maps to "${p}", which is not a pillar`);
    }
  }
});

test('the lifestyle pillars can only be served by lifestyle subjects', () => {
  // The finding that matters: no amount of consultation photography covers a
  // post about food, sleep or movement.
  for (const clinical of ['consultation', 'team', 'iv-suite', 'treatment-room', 'reception'] as const) {
    const p = pillarsFor({ subjects: [clinical] });
    for (const lifestyle of ['nutrition', 'practical-nutrition', 'sleep', 'stress', 'movement']) {
      assert.ok(!p.includes(lifestyle), `${clinical} should not claim to illustrate ${lifestyle}`);
    }
  }
  assert.deepEqual(pillarsFor({ subjects: ['food'] }), ['nutrition', 'practical-nutrition', 'supplementation']);
  assert.deepEqual(pillarsFor({ subjects: ['rest'] }), ['sleep', 'stress']);
});

test('a procedure photograph illustrates nothing, however good it is', () => {
  assert.deepEqual(pillarsFor({ subjects: ['procedure'] }), []);
  assert.equal(coverSafe({ blockers: ['procedure'] }).ok, false);
});

test('consent is reported apart from the rule failures', () => {
  const s = coverSafe({ blockers: ['identifiable-patient'] });
  assert.equal(s.ok, true, 'a recognisable patient is a consent question, not a defect');
  assert.equal(s.needsConsent, true);
  assert.deepEqual(s.why, []);

  const t = coverSafe({ blockers: ['identifiable-patient', 'text'] });
  assert.equal(t.ok, false);
  assert.deepEqual(t.why, ['text']);
  assert.equal(t.needsConsent, true);
});

test('the inventory counts only pictures the rules would actually allow', () => {
  const ids = PILLARS.map((p) => p.id);
  const inv = inventory([
    cap(['consultation']),                    // usable
    cap(['consultation'], ['text']),          // refused — signage
    cap(['procedure'], ['procedure', 'device-on-person']),
    cap(['food']),                            // usable, and the only nutrition hit
    cap(['portrait'], ['identifiable-patient']), // usable, but needs a release
  ], ids);
  assert.equal(inv.total, 5);
  assert.equal(inv.usable, 3);
  assert.equal(inv.needsConsent, 1);
  assert.equal(inv.byPillar.nutrition, 1);
  assert.equal(inv.byPillar.sleep, 0);
  assert.equal(inv.byPillar.diagnosis, 2, 'the consultation and the portrait');
  assert.equal(inv.byBlocker.text, 1);
  assert.equal(inv.byBlocker.procedure, 1);
});

test('the prompt names every word the parser will accept', () => {
  const p = captionSystemPrompt();
  for (const s of SUBJECTS) assert.ok(p.includes(s), `the prompt never mentions "${s}"`);
  for (const b of BLOCKERS) assert.ok(p.includes(b), `the prompt never mentions "${b}"`);
  assert.match(p, /When in doubt, say text/);
});

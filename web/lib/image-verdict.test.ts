import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVerdict } from './image-verdict.ts';

test('the two findings from the live deployment are advisory, not a flag', () => {
  // Exactly what the reviewer said about four of five usable photos.
  const v = classifyVerdict({ approved: false, textDetected: false, score: 72,
    issues: ['Unclear relevance to stem cell therapy', 'Presence of non-specific background elements'] });
  assert.equal(v.status, 'approved');
  assert.equal(v.issues.length, 0);
  assert.equal(v.advisory.length, 2);
});

test('text is always a flag, and always names itself', () => {
  const v = classifyVerdict({ approved: true, textDetected: true, issues: [] });
  assert.equal(v.status, 'flagged');
  assert.equal(v.textDetected, true);
  assert.match(v.issues[0], /text/i);
});

test('a text mention in the findings flags even without the dedicated flag', () => {
  const v = classifyVerdict({ approved: true, textDetected: false, issues: ['small lettering on a bottle label'] });
  assert.equal(v.status, 'flagged');
  assert.equal(v.textDetected, true);
});

test('anatomy, logos and graphic content are blocking', () => {
  for (const finding of ['six fingers on the left hand', 'a watermark in the corner', 'a needle piercing skin', 'warped face']) {
    const v = classifyVerdict({ approved: false, issues: [finding] });
    assert.equal(v.status, 'flagged', finding);
    assert.deepEqual(v.issues, [finding]);
  }
});

test("the reviewer's own blocking/advisory split is honoured", () => {
  const v = classifyVerdict({ approved: false, blocking: ['merged bodies'], advisory: ['a bit stock-like'] });
  assert.equal(v.status, 'flagged');
  assert.deepEqual(v.issues, ['merged bodies']);
  assert.deepEqual(v.advisory, ['a bit stock-like']);
});

test('a defect filed under advisory is promoted', () => {
  const v = classifyVerdict({ approved: true, blocking: [], advisory: ['pleasant lighting', 'extra arm behind the chair'] });
  assert.equal(v.status, 'flagged');
  assert.deepEqual(v.issues, ['extra arm behind the chair']);
  assert.deepEqual(v.advisory, ['pleasant lighting']);
});

test('a veto with no reason is respected, and says so', () => {
  const v = classifyVerdict({ approved: false, issues: [] });
  assert.equal(v.status, 'flagged');
  assert.match(v.issues[0], /without naming/);
});

test('a clean answer is clean', () => {
  const v = classifyVerdict({ approved: true, textDetected: false, score: 91, issues: [] });
  assert.equal(v.status, 'approved');
  assert.equal(v.score, 91);
  assert.deepEqual(v.advisory, []);
});

test('brand fit rides along as a number and never changes the status', () => {
  const clean = classifyVerdict({ approved: true, textDetected: false, score: 90, brandFit: 23, blocking: [], advisory: ['cool blue palette'] });
  assert.equal(clean.status, 'approved', 'a poor brand fit is an opinion, not a defect');
  assert.equal(clean.brandFit, 23);
  const clamped = classifyVerdict({ approved: true, textDetected: false, score: 90, brandFit: 140, blocking: [], advisory: [] });
  assert.equal(clamped.brandFit, 100);
  const missing = classifyVerdict({ approved: true, textDetected: false, score: 90, blocking: [], advisory: [] });
  assert.equal(missing.brandFit, null, 'an older reviewer answer has no brand fit');
  const flagged = classifyVerdict({ approved: false, textDetected: true, score: 10, brandFit: 99, blocking: ['visible text'], advisory: [] });
  assert.equal(flagged.status, 'flagged', 'a perfect brand fit cannot rescue text');
});

test('weekly-planner images: off-topic is a defect; everywhere else it stays advisory', () => {
  const raw = { approved: true, textDetected: false, onTopic: false, blocking: [], advisory: ['unclear relevance'] };
  assert.equal(classifyVerdict(raw).status, 'approved');
  const v = classifyVerdict(raw, { requireOnTopic: true });
  assert.equal(v.status, 'flagged');
  assert.match(v.issues[0], /off-topic/);
  assert.equal(classifyVerdict({ ...raw, onTopic: true }, { requireOnTopic: true }).status, 'approved');
});

test('planner covers: a head in the title band is a defect', () => {
  const clean = { approved: true, textDetected: false, onTopic: true, blocking: [], advisory: [] };
  assert.equal(classifyVerdict({ ...clean, headTopPct: 18 }, { requireOnTopic: true, minHeadTopPct: 25 }).status, 'flagged');
  assert.equal(classifyVerdict({ ...clean, headTopPct: 38 }, { requireOnTopic: true, minHeadTopPct: 25 }).status, 'approved');
  assert.equal(classifyVerdict({ ...clean, headTopPct: 18 }).status, 'approved');
});

test('a banned prop fails the image on its own, whatever else the reviewer said', () => {
  // A flat lay came back with a model brain in one hand and an amber pill
  // bottle beside it. The reviewer approved it: the prop rule was a clause at
  // the end of a long on-topic paragraph, and it sailed past.
  const v = classifyVerdict({ approved: true, textDetected: false, bannedProp: true, onTopic: true, score: 88, blocking: [], advisory: [] }, { requireOnTopic: true });
  assert.equal(v.status, 'flagged');
  assert.match(v.issues.join(' '), /banned prop/i);
});

test('a prop named only in advisory is promoted to blocking', () => {
  for (const note of ['a model brain is held in the hand', 'an amber pill bottle sits on the table', 'a plastic skeleton in the background']) {
    const v = classifyVerdict({ approved: true, textDetected: false, score: 90, blocking: [], advisory: [note] }, { requireOnTopic: true });
    assert.equal(v.status, 'flagged', note);
  }
});

test('an ordinary clinic still life is untouched by the prop rule', () => {
  const v = classifyVerdict({ approved: true, textDetected: false, bannedProp: false, onTopic: true, score: 92, blocking: [], advisory: ['the linen could be smoother'] }, { requireOnTopic: true });
  assert.equal(v.status, 'approved');
});

test('a device worn by or given to a person is blocking, wherever it is named', () => {
  for (const note of [
    'a blood pressure cuff is on the patient\'s upper arm',
    'ECG electrodes are visible on the chest',
    'a pulse oximeter is clipped to a finger',
    'an IV line runs to the arm',
    'an injector pen is held toward the patient',
  ]) {
    const v = classifyVerdict({ approved: true, textDetected: false, score: 90, blocking: [], advisory: [note] }, { requireOnTopic: true });
    assert.equal(v.status, 'flagged', note);
  }
});

test('the same device resting unused on a table is not blocked by wording alone', () => {
  // The rule is about what is attached to a person. A stethoscope lying on the
  // desk is in the pillar's own object list and must keep passing.
  const v = classifyVerdict({ approved: true, textDetected: false, bannedProp: false, onTopic: true, score: 91, blocking: [], advisory: ['a stethoscope rests on the notebook'] }, { requireOnTopic: true });
  assert.equal(v.status, 'approved');
});

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

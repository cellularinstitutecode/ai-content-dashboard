// The remark that replaces a refusal when only the citation is wrong.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalRemarkNote, approvalRemarksOf, withApprovalRemarks } from './approval-remarks.ts';

test('remarks are appended to the pack, newest last, and nothing else is touched', () => {
  const pack = { instagram: 'Post.', _image: { url: 'x' } };
  const next = withApprovalRemarks(pack, ['The REF line is missing.'], '2026-10-08T00:00:00Z');
  assert.deepEqual(approvalRemarksOf(next), [{ at: '2026-10-08T00:00:00Z', text: 'The REF line is missing.' }]);
  assert.equal(next.instagram, 'Post.');
  assert.deepEqual(next._image, { url: 'x' });
  const again = withApprovalRemarks(next, ['The DOI points at a different paper.'], '2026-10-09T00:00:00Z');
  assert.equal(approvalRemarksOf(again).length, 2);
  assert.equal(approvalRemarksOf(again)[1].text, 'The DOI points at a different paper.');
});

test('empty and junk remarks leave the pack alone', () => {
  const pack = { instagram: 'Post.' };
  assert.equal(withApprovalRemarks(pack, []), pack);
  assert.equal(withApprovalRemarks(pack, ['', '   ']), pack);
  assert.deepEqual(approvalRemarksOf({ _approvalRemarks: 'nope' }), []);
  assert.deepEqual(approvalRemarksOf({ _approvalRemarks: [{ at: 'x', text: '' }, 7, null] }), []);
});

test('the note reads as one sentence, whatever the count', () => {
  assert.equal(approvalRemarkNote([]), '');
  assert.match(approvalRemarkNote(['A.']), /^Approved with a remark on the citation — A\.$/);
  assert.match(approvalRemarkNote(['A.', 'B.']), /^Approved with 2 remarks on the citation — A\. B\.$/);
});

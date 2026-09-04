// The rule that decides whether a post can go out.
//
// The trap: posts.status DEFAULTS to 'scheduled' in schema.sql, and
// /api/metricool/schedule stored whatever Metricool called the post — a
// vocabulary that includes 'scheduled' for a post Metricool is holding in its
// REVIEW queue (app/api/assistant/route.ts already carried a guard against
// exactly that; the other path did not). Treating 'scheduled' as approved
// would mean dragging an unapproved post to another day published it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeOfStatus, isAwaitingApproval, APPROVED_STATUS } from './post-mode.ts';

test('only an approved post is sent to the live queue', () => {
  assert.equal(modeOfStatus(APPROVED_STATUS), 'scheduled');
  assert.equal(modeOfStatus('Approved'), 'scheduled');
});

test("'scheduled' does NOT mean anybody approved anything", () => {
  // The column default. A row nobody has touched must not publish itself the
  // first time somebody drags it to another day.
  assert.equal(modeOfStatus('scheduled'), 'review');
  // Metricool's word for a post in its review queue.
  assert.equal(modeOfStatus('SCHEDULED'), 'review');
  assert.equal(modeOfStatus('queued'), 'review');
});

test('anything unrecognised stays in review', () => {
  for (const s of ['pending_review', 'draft', 'pending', '', null, undefined, 'wat', 0]) {
    assert.equal(modeOfStatus(s), 'review', JSON.stringify(s) + ' was treated as live');
  }
});

test('a post waiting for a person shows its Approve button', () => {
  for (const s of ['pending_review', 'draft', 'pending', 'scheduled', 'queued', '', null]) {
    assert.equal(isAwaitingApproval(s), true, JSON.stringify(s) + ' had its Approve button hidden');
  }
});

test('a post that is out, or that failed, is not awaiting approval', () => {
  for (const s of ['published', 'sent', 'live', 'failed', 'error', 'rejected']) {
    assert.equal(isAwaitingApproval(s), false, s);
  }
  assert.equal(isAwaitingApproval(APPROVED_STATUS), false);
});

test('the button and the wire agree', () => {
  // If the UI says a post is still waiting, the API must not send it live —
  // and if the UI says it is scheduled, the API must not drop it back to
  // review. Disagreement here is how a post publishes without being approved.
  for (const s of ['pending_review', 'draft', 'scheduled', 'queued', 'approved', '', 'wat']) {
    assert.equal(isAwaitingApproval(s), modeOfStatus(s) === 'review', s);
  }
});

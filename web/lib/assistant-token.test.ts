// The consent gate for the one path that spends AI credit and writes posts into
// the clinic's Metricool queue. It shipped with no tests at all — the module was
// marked `server-only`, which put it outside what the test runner can load, and
// the audit that followed found two ways past it. Run with: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signBatch, batchIsAuthentic, claimBatch, newTicketId, BATCH_TTL_MS, type BatchTicket } from './assistant-token.ts';

process.env.ASSISTANT_SESSION_SECRET = 'test-secret-for-batch-tickets';

const ticket = (over: Partial<BatchTicket> = {}): BatchTicket => ({
  userId: 'user-1',
  expiresAt: Date.now() + BATCH_TTL_MS,
  jti: newTicketId(),
  items: [{ topic: 'NK cells', network: 'instagram', publishAt: '2030-01-01T09:00' }],
  ...over,
});

test('a ticket this server signed verifies', () => {
  const t = ticket();
  assert.equal(batchIsAuthentic(t, signBatch(t)!, 'user-1'), true);
});

test('a ticket issued to someone else is refused', () => {
  const t = ticket();
  assert.equal(batchIsAuthentic(t, signBatch(t)!, 'user-2'), false);
});

test('an expired ticket is refused even with a valid signature', () => {
  const t = ticket({ expiresAt: Date.now() - 1 });
  assert.equal(batchIsAuthentic(t, signBatch(t)!, 'user-1'), false);
});

test('editing any item breaks the signature', () => {
  const t = ticket();
  const sig = signBatch(t)!;
  for (const mutate of [
    (x: BatchTicket) => { x.items[0].topic = 'something else'; },
    (x: BatchTicket) => { x.items[0].network = 'facebook'; },
    (x: BatchTicket) => { x.items[0].publishAt = '2030-02-02T09:00'; },
    (x: BatchTicket) => { x.items.push({ topic: 'extra', network: 'linkedin', publishAt: '2030-01-02T09:00' }); },
  ]) {
    const forged = JSON.parse(JSON.stringify(t)) as BatchTicket;
    mutate(forged);
    assert.equal(batchIsAuthentic(forged, sig, 'user-1'), false);
  }
});

// The audit finding. `i.mediaUrl ?? ''` mapped undefined, null and '' onto the
// same bytes, while draftAndQueue branches on truthiness — so a batch approved
// as "reel with video" could have its media REMOVED and still verify, queueing
// the approved copy as a text-only post.
test('removing the media from an approved item breaks the signature', () => {
  const withMedia = ticket({
    items: [{ topic: 'A', network: 'instagram', publishAt: '2030-01-01T09:00', mediaUrl: 'https://drive.google.com/file/d/abc/view' }],
  });
  const sig = signBatch(withMedia)!;

  const stripped = JSON.parse(JSON.stringify(withMedia)) as BatchTicket;
  delete stripped.items[0].mediaUrl;
  assert.equal(batchIsAuthentic(stripped, sig, 'user-1'), false, 'deleting the key must not verify');

  const emptied = JSON.parse(JSON.stringify(withMedia)) as BatchTicket;
  emptied.items[0].mediaUrl = '';
  assert.equal(batchIsAuthentic(emptied, sig, 'user-1'), false, 'emptying the value must not verify');
});

test('absent and empty are distinguishable in both directions', () => {
  const absent = ticket({ items: [{ topic: 'A', network: 'instagram', publishAt: '2030-01-01T09:00' }] });
  const empty = ticket({ jti: absent.jti, expiresAt: absent.expiresAt, items: [{ topic: 'A', network: 'instagram', publishAt: '2030-01-01T09:00', mediaUrl: '' }] });
  assert.notEqual(signBatch(absent), signBatch(empty));
  // And the same for format, which decides whether a YouTube post is a Short.
  const noFormat = ticket({ items: [{ topic: 'A', network: 'youtube', publishAt: '2030-01-01T09:00' }] });
  const withFormat = ticket({ jti: noFormat.jti, expiresAt: noFormat.expiresAt, items: [{ topic: 'A', network: 'youtube', publishAt: '2030-01-01T09:00', format: 'video' }] });
  assert.notEqual(signBatch(noFormat), signBatch(withFormat));
});

test('a ticket with no id is refused — it could never be spent', () => {
  const t = ticket({ jti: '' });
  assert.equal(batchIsAuthentic(t, signBatch(t) ?? '', 'user-1'), false);
});

// --- single use -------------------------------------------------------------
//
// The session round-trips through the BROWSER, so clearing session.pendingBatch
// server-side only edits the copy in that response. The client still holds the
// pre-confirmation body; re-posting it with "yes" ran the whole batch again.
test('a ticket can be claimed exactly once', () => {
  const id = newTicketId();
  assert.equal(claimBatch(id), true, 'the first claim wins');
  assert.equal(claimBatch(id), false, 'the replay loses');
  assert.equal(claimBatch(id), false, 'and keeps losing');
});

test('two different batches do not block each other', () => {
  assert.equal(claimBatch(newTicketId()), true);
  assert.equal(claimBatch(newTicketId()), true);
});

test('an empty id is never claimable', () => {
  assert.equal(claimBatch(''), false);
});

test('a claim stops blocking once it has expired', () => {
  const id = newTicketId();
  assert.equal(claimBatch(id, 1), true);
  // The record is kept for the ticket's own lifetime and no longer; a ticket
  // that has outlived its claim record has also outlived its expiresAt, so
  // batchIsAuthentic refuses it before claimBatch is ever consulted.
  const past = Date.now() + 5;
  while (Date.now() < past) { /* spin briefly */ }
  assert.equal(claimBatch(id, 1), true);
});

test('ticket ids are unguessable and unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newTicketId()));
  assert.equal(ids.size, 200);
  assert.match(newTicketId(), /^[0-9a-f]{32}$/);
});

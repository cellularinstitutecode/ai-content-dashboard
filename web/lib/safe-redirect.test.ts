// Open-redirect containment for the ?next= destination. Run with: npm test
//
// Both call sites (the auth callback and the sign-in page) used to guard with
// `next.startsWith('/') && !next.startsWith('//')`, and both carried a comment
// asserting it was safe. It is not: `new URL('/\\evil.com', base)` resolves to
// `https://evil.com/`, and browsers normalise the backslash the same way when
// the value reaches `window.location.href`. The victim signs in successfully and
// lands on the attacker's page - the most convincing possible moment for a
// credential-phishing relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from './safe-redirect.ts';

const ORIGIN = 'https://dashboard.example.com';

test('the backslash bypass that defeated the old prefix check', () => {
  // Sanity: this really is an escape, not a hypothetical.
  assert.equal(new URL('/\\evil.com', ORIGIN).origin, 'https://evil.com');
  // And the old guard would have waved it through.
  const oldGuard = (n: string) => n.startsWith('/') && !n.startsWith('//');
  assert.equal(oldGuard('/\\evil.com'), true);
  // The new one does not.
  assert.equal(safeNextPath('/\\evil.com', ORIGIN), '/');
});

test('off-origin destinations all collapse to /', () => {
  for (const bad of [
    '//evil.com',
    '///evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    'https://evil.com',
    'http://evil.com/path',
    '//evil.com/@dashboard.example.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '\t/\\evil.com',
    '\n//evil.com',
  ]) {
    assert.equal(safeNextPath(bad, ORIGIN), '/', 'should have rejected: ' + JSON.stringify(bad));
  }
});

test('same-origin paths survive intact, query and hash included', () => {
  assert.equal(safeNextPath('/', ORIGIN), '/');
  assert.equal(safeNextPath('/calendar', ORIGIN), '/calendar');
  assert.equal(safeNextPath('/templates?tab=weekly', ORIGIN), '/templates?tab=weekly');
  assert.equal(safeNextPath('/brand#voice', ORIGIN), '/brand#voice');
  assert.equal(safeNextPath('/?draft=abc-123', ORIGIN), '/?draft=abc-123');
});

test('an absolute URL on our own origin is allowed, and normalised to a path', () => {
  assert.equal(safeNextPath(ORIGIN + '/calendar', ORIGIN), '/calendar');
});

test('junk input falls back to / rather than throwing', () => {
  assert.equal(safeNextPath(undefined, ORIGIN), '/');
  assert.equal(safeNextPath(null, ORIGIN), '/');
  assert.equal(safeNextPath('', ORIGIN), '/');
  assert.equal(safeNextPath(42 as unknown, ORIGIN), '/');
  assert.equal(safeNextPath({ toString: () => '/evil' } as unknown, ORIGIN), '/');
  assert.equal(safeNextPath('/ok', 'not-a-url'), '/');
});

test('a path that walks up cannot leave the origin', () => {
  assert.equal(safeNextPath('/../../etc/passwd', ORIGIN), '/etc/passwd');
  assert.equal(safeNextPath('/a/../b', ORIGIN), '/b');
});

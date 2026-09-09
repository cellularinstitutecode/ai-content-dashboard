import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyRole, serviceKeyVerdict } from './supabase-key.ts';

/** A JWT-shaped key with the given role, as Supabase issues them. */
function jwt(role: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: 'supabase', role, iat: 1, exp: 2 }) + '.signature';
}

test('a key states its own role', () => {
  assert.equal(keyRole(jwt('service_role')), 'service_role');
  assert.equal(keyRole(jwt('anon')), 'anon');
  assert.equal(keyRole(jwt('authenticated')), 'other');
});

test('the newer key formats are read from their prefix', () => {
  assert.equal(keyRole('sb_secret_abc123'), 'service_role');
  assert.equal(keyRole('sb_publishable_abc123'), 'anon');
});

test('anything unreadable says so rather than guessing', () => {
  // Guessing here would put this check back in the business of speculation,
  // which is the entire reason it exists.
  assert.equal(keyRole(''), 'unknown');
  assert.equal(keyRole(undefined), 'unknown');
  assert.equal(keyRole('not-a-jwt'), 'unknown');
  assert.equal(keyRole('a.b.c'), 'unknown', 'three segments of nonsense is not a payload');
  assert.equal(keyRole(jwt('')), 'unknown');
});

test('the anon key in the service-role slot is called out, loudly', () => {
  const v = serviceKeyVerdict(jwt('anon'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'anon_key');
  // The whole point is explaining the contradiction the person is looking at.
  assert.match(v.detail, /saving Brand Brain works/i);
  assert.match(v.detail, /zero rows|never saved|nobody ever saved/i);
});

test('the right key passes and an absent one fails', () => {
  assert.equal(serviceKeyVerdict(jwt('service_role')).ok, true);
  assert.equal(serviceKeyVerdict('').ok, false);
  assert.equal(serviceKeyVerdict(undefined).code, 'missing');
});

test('an unreadable key is not reported as broken', () => {
  // Failing a deployment because a key format is newer than this code would be
  // a false alarm on a healthy system.
  const v = serviceKeyVerdict('some-future-format');
  assert.equal(v.ok, true);
  assert.equal(v.code, 'unreadable');
});

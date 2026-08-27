// The authorization table for the three machine paths. Run with: npm test
//
// This file exists because of a specific bug. The middleware exempted three
// paths from BOTH session auth and the tenant allowlist whenever the request
// merely CARRIED an `authorization` / `x-opus-*` header - the value was never
// compared, and the header set was global rather than per-path. An
// authenticated-but-not-allowlisted account (self-registered against the public
// anon key, or an ex-employee removed from ALLOWED_EMAILS) could send
// `Authorization: Bearer x`, reach POST /api/metricool/sync, and have the
// clinic's org-wide Metricool analytics written into rows it owned - then read
// them straight back out through owner-scoped RLS.
//
// Every row below is a case that bug got wrong. Reintroducing it fails a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMachineRequest, isMachinePath, MACHINE_PATHS } from './machine-auth.ts';

const SECRET = 'correct-horse-battery-staple';

function headers(init: Record<string, string> = {}) {
  const lower = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (n: string) => lower.get(n.toLowerCase()) ?? null,
    has: (n: string) => lower.has(n.toLowerCase()),
  };
}

type Row = {
  name: string;
  path: string;
  headers: Record<string, string>;
  secret: string | undefined;
  expected: boolean;
};

const TABLE: Row[] = [
  // --- the regression itself -------------------------------------------------
  {
    name: 'a forged bearer does NOT exempt the metrics sync',
    path: '/api/metricool/sync',
    headers: { authorization: 'Bearer not-the-secret' },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'an empty bearer does NOT exempt the metrics sync',
    path: '/api/metricool/sync',
    headers: { authorization: '' },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'a forged bearer does NOT exempt the autopilot tick',
    path: '/api/autopilot/tick',
    headers: { authorization: 'Bearer not-the-secret' },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'an Opus signature header does NOT exempt the autopilot tick',
    path: '/api/autopilot/tick',
    headers: { 'x-opus-signature': 'deadbeef' },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'an Opus signature header does NOT exempt the metrics sync',
    path: '/api/metricool/sync',
    headers: { 'x-opus-signature': 'deadbeef' },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'an Opus timestamp header alone exempts nothing at all',
    path: '/api/opus/webhook',
    headers: { 'x-opus-timestamp': '1756300000' },
    secret: SECRET,
    expected: false,
  },

  // --- the traffic the exemption exists for ---------------------------------
  {
    name: 'the real cron bearer exempts the metrics sync',
    path: '/api/metricool/sync',
    headers: { authorization: 'Bearer ' + SECRET },
    secret: SECRET,
    expected: true,
  },
  {
    name: 'the real cron bearer exempts the autopilot tick',
    path: '/api/autopilot/tick',
    headers: { authorization: 'Bearer ' + SECRET },
    secret: SECRET,
    expected: true,
  },
  {
    name: 'a signed Opus webhook reaches its own HMAC check',
    path: '/api/opus/webhook',
    headers: { 'x-opus-signature': 'deadbeef', 'x-opus-timestamp': '1756300000' },
    secret: SECRET,
    expected: true,
  },

  // --- fail closed when the secret is not configured ------------------------
  {
    name: 'with CRON_SECRET unset, no bearer exempts the sync',
    path: '/api/metricool/sync',
    headers: { authorization: 'Bearer ' + SECRET },
    secret: undefined,
    expected: false,
  },
  {
    name: 'with CRON_SECRET empty, no bearer exempts the tick',
    path: '/api/autopilot/tick',
    headers: { authorization: 'Bearer ' },
    secret: '',
    expected: false,
  },

  // --- nothing else is a machine path ---------------------------------------
  {
    name: 'an ordinary route is never exempt, whatever it carries',
    path: '/api/drafts',
    headers: { authorization: 'Bearer ' + SECRET, 'x-opus-signature': 'deadbeef' },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'a lookalike path is not a machine path',
    path: '/api/metricool/sync/extra',
    headers: { authorization: 'Bearer ' + SECRET },
    secret: SECRET,
    expected: false,
  },
  {
    name: 'no headers, no exemption',
    path: '/api/metricool/sync',
    headers: {},
    secret: SECRET,
    expected: false,
  },
];

for (const row of TABLE) {
  test(row.name, () => {
    assert.equal(
      isMachineRequest(row.path, headers(row.headers), row.secret),
      row.expected,
    );
  });
}

test('the machine-path list is exactly the three routes middleware exempts', () => {
  assert.deepEqual([...MACHINE_PATHS], [
    '/api/opus/webhook',
    '/api/metricool/sync',
    '/api/autopilot/tick',
  ]);
  assert.equal(isMachinePath('/api/drafts'), false);
  assert.equal(isMachinePath('/api/autopilot/tick'), true);
});

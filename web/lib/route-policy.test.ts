// Policy tests over the API surface. Run with: npm test
//
// These do not exercise the routes - they read the source and assert invariants
// that the audit found broken. That is deliberate: the expensive failures in this
// codebase were not "this function returns the wrong number", they were "this
// route forgot the thing every other route does". A source-level check catches
// the next forgetting without needing Supabase, Metricool or a running server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = join(WEB_ROOT, 'app', 'api');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(full);
  }
  return out;
}

const ROUTES = routeFiles(API_ROOT).map((f) => ({
  path: relative(WEB_ROOT, f).replace(/\\/g, '/'),
  source: readFileSync(f, 'utf8'),
}));

// Routes that legitimately authenticate by some means other than a user session.
// Anything added here is a deliberate decision that a reviewer has to make.
const NON_SESSION_ROUTES: Record<string, string> = {
  'app/api/opus/webhook/route.ts':
    'Authenticates with an HMAC over the raw body (timing-safe, freshness window, replay guard).',
};

test('every API route authenticates its caller', () => {
  const missing: string[] = [];
  for (const r of ROUTES) {
    if (NON_SESSION_ROUTES[r.path]) {
      // Still assert the stated alternative is actually there.
      assert.match(
        r.source,
        /timingSafeEqual|createHmac/,
        r.path + ' claims HMAC auth but does not verify a signature',
      );
      continue;
    }
    const gated =
      /requireAllowlistedUser\s*\(/.test(r.source) ||
      /requireUser\s*\(/.test(r.source) ||
      /auth\.getUser\s*\(/.test(r.source);
    if (!gated) missing.push(r.path);
  }
  assert.deepEqual(
    missing,
    [],
    'these API routes have no authentication gate:\n  ' + missing.join('\n  '),
  );
});

test('routes that reach the shared org accounts require the tenant allowlist', () => {
  // These touch resources that belong to the clinic rather than to a user: the
  // org-wide Metricool token, the shared Semrush unit pot, the AI budget. A
  // valid session is the weaker question; being one of our people is the right
  // one. Middleware enforces this too - these are the copies that stay correct
  // if the middleware exemption ever widens again, which is exactly what
  // happened once already.
  const mustBeAllowlisted = [
    'app/api/metricool/sync/route.ts',
    'app/api/autopilot/tick/route.ts',
    'app/api/health/route.ts',
  ];
  for (const path of mustBeAllowlisted) {
    const route = ROUTES.find((r) => r.path === path);
    assert.ok(route, 'expected route to exist: ' + path);
    assert.match(
      route!.source,
      /requireAllowlistedUser\s*\(/,
      path + ' must call requireAllowlistedUser()',
    );
  }
});

test('no route lets the caller decide whether a post publishes', () => {
  // `autoPublish` was a request parameter on /api/metricool/schedule, so any
  // signed-in caller could switch off the human review step standing between
  // generated copy and a medical clinic's live social accounts. Publishing is a
  // property of the server, never of the request body.
  const offenders = ROUTES.filter((r) =>
    /(?:payload|body|input|req)\s*(?:\.|\[['"])\s*autoPublish/.test(r.source),
  ).map((r) => r.path);
  assert.deepEqual(
    offenders,
    [],
    'these routes read autoPublish from the request:\n  ' + offenders.join('\n  '),
  );
});

test('the Metricool handoff always asks for a draft, never a live post', () => {
  const route = ROUTES.find((r) => r.path === 'app/api/metricool/schedule/route.ts');
  assert.ok(route, 'expected the schedule route to exist');
  assert.match(route!.source, /autoPublish:\s*false/, 'must send autoPublish: false');
  assert.match(route!.source, /draft:\s*true/, 'must send draft: true');
  assert.doesNotMatch(route!.source, /draft:\s*!/, 'draft must be a constant, not derived');
});

test('every route that spends money on a third party is rate limited', () => {
  // The cap is what stands between a loop and an invoice. /api/realtime-session
  // minted OpenAI Realtime credentials with no limit at all; the schedule route
  // reached a live brand account with none either.
  const spenders = [
    'app/api/generate/route.ts',
    'app/api/transform/route.ts',
    'app/api/assistant/route.ts',
    'app/api/keywords/route.ts',
    'app/api/semrush/route.ts',
    'app/api/opus/clip/route.ts',
    'app/api/drafts/image/route.ts',
    'app/api/realtime-session/route.ts',
    'app/api/metricool/schedule/route.ts',
    'app/api/autopilot/tick/route.ts',
    'app/api/autopilot/runs/route.ts',
  ];
  for (const path of spenders) {
    const route = ROUTES.find((r) => r.path === path);
    assert.ok(route, 'expected route to exist: ' + path);
    assert.match(route!.source, /checkRateLimit\s*\(/, path + ' must call checkRateLimit()');
  }
});

test('the service-role client is never imported by a client component', () => {
  // lib/supabase-admin.ts is marked `server-only`, so this would already be a
  // build error. Asserting it here makes the reason legible in a test name.
  const clientFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) clientFiles.push(full);
    }
  };
  walk(join(WEB_ROOT, 'app'));
  walk(join(WEB_ROOT, 'components'));

  const offenders = clientFiles.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /^['"]use client['"]/m.test(src) && /supabase-admin/.test(src);
  });
  assert.deepEqual(offenders, [], 'client components importing the service-role client');
});

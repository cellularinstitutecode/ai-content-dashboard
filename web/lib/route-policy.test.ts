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
  // Two mechanisms, because each alone was wrong.
  //
  // v1 asserted a hard-coded list of three paths: it passed forever and read as
  // though the invariant were enforced everywhere.
  //
  // v2 derived the list from regexes over each route's own source. That is a
  // better net for NEW routes, but it silently dropped the two routes where the
  // gate matters most - /api/metricool/sync and /api/autopilot/tick reach
  // Metricool and Semrush through imported helpers, so neither name appears in
  // their own source, and they are exactly the paths middleware exempts, where
  // the route-level check is the only protection left.
  //
  // So: a FLOOR that can never shrink, plus the derived net on top.

  // Routes that must always be allowlisted, whatever a regex thinks. Removing a
  // line here is a deliberate act.
  const FLOOR = [
    'app/api/metricool/sync/route.ts',   // org-wide Metricool via fetchPostMetrics
    'app/api/autopilot/tick/route.ts',   // Metricool + Semrush + AI via lib/autopilot
    'app/api/metricool/schedule/route.ts',
    'app/api/autopilot/runs/route.ts',
    'app/api/assistant/route.ts',
    'app/api/semrush/route.ts',
    'app/api/keywords/route.ts',
    'app/api/generate/route.ts',
    'app/api/metricool/ai-research/route.ts',
    'app/api/metricool/route.ts',
    'app/api/metricool/insights/route.ts',
    'app/api/realtime-session/route.ts',
    'app/api/health/route.ts',
  ];

  const gated = (src: string) => /requireAllowlistedUser\s*\(|isAllowedEmail\s*\(/.test(src);

  const floorMisses: string[] = [];
  for (const path of FLOOR) {
    const route = ROUTES.find((r) => r.path === path);
    assert.ok(route, 'FLOOR names a route that does not exist: ' + path);
    if (!gated(route!.source)) floorMisses.push(path);
  }
  assert.deepEqual(floorMisses, [], 'these routes lost their allowlist gate:\n  ' + floorMisses.join('\n  '));

  // The net: any route naming a shared resource directly must also be gated.
  // Catches new routes the FLOOR has not been told about yet.
  const SHARED = [
    { name: 'the org-wide Metricool account', re: /METRICOOL_USER_TOKEN|metricoolSchedulePost|fetchPostMetrics|doSchedule|approveRun/ },
    { name: 'the shared Semrush unit pot', re: /SEMRUSH_API_KEY|researchBundle|domainBundle|getUnitsBalance|researchKeywords/ },
    { name: 'the shared AI budget', re: /generateContentPack|chatWithTools|researchTopic|generatePackImage/ },
    { name: 'the paid OpusClip account', re: /opusCreateClipProject/ },
  ];
  const netMisses: string[] = [];
  for (const r of ROUTES) {
    if (NON_SESSION_ROUTES[r.path]) continue;
    if (FLOOR.includes(r.path)) continue;
    const touches = SHARED.filter((x) => x.re.test(r.source));
    if (touches.length && !gated(r.source)) {
      netMisses.push(r.path + ' (reaches ' + touches.map((t) => t.name).join(' + ') + ')');
    }
  }
  assert.deepEqual(
    netMisses,
    [],
    'these routes reach a shared clinic resource on nothing but a session:\n  ' +
      netMisses.join('\n  ') +
      '\nAdd requireAllowlistedUser()/isAllowedEmail(), or add the path to FLOOR with a reason.',
  );
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

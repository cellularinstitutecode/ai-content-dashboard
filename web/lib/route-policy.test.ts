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
    // metricoolReplacePost and metricoolDeletePost were missing, and they are
    // the two that APPROVE a post into the live queue and DELETE one. So
    // /api/posts — the single most consequential route in the app — slipped
    // through the net built to catch exactly this, and went un-gated.
    { name: 'the org-wide Metricool account', re: /METRICOOL_USER_TOKEN|metricoolSchedulePost|metricoolReplacePost|metricoolDeletePost|fetchPostMetrics|doSchedule|approveRun|draftAndQueue/ },
    { name: 'the shared Semrush unit pot', re: /SEMRUSH_API_KEY|researchBundle|domainBundle|getUnitsBalance|researchKeywords/ },
    { name: 'the shared AI budget', re: /generateContentPack|chatWithTools|chatAssistant|researchTopic|generatePackImage/ },
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

// The route test above reads app/api only. draftAndQueue puts posts into the
// clinic's Metricool queue from lib/, so the invariant has to follow it there —
// otherwise the one code path that creates posts in BULK is the one path not
// covered by the check that keeps posts out of the live queue.
test('the batch drafter queues drafts and cannot be argued into publishing', () => {
  const src = readFileSync(join(WEB_ROOT, 'lib', 'batch-draft.ts'), 'utf8');
  assert.match(src, /autoPublish:\s*false/, 'must send autoPublish: false');
  assert.match(src, /draft:\s*true/, 'must send draft: true');
  // Constants, not expressions: no ternary, no variable, nothing an input can
  // reach. This is the assertion that would have caught autoPublish being a
  // request parameter on the schedule route.
  // Negative lookahead, not a negated class: `\s*` matches zero characters, so
  // /draft:\s*[^t]/ matches the space in "draft: true" and the check passes for
  // the wrong reason on every input. Worth the note — a security assertion that
  // cannot fail is worse than no assertion, because it reads as coverage.
  assert.doesNotMatch(src, /draft:(?!\s*true\b)/, 'draft must be the literal true');
  assert.doesNotMatch(src, /autoPublish:(?!\s*false\b)/, 'autoPublish must be the literal false');
  assert.doesNotMatch(
    src,
    /(?:item|input|body|opts|payload)\s*(?:\.|\[['"])\s*(?:autoPublish|draft)\b/,
    'neither flag may be read from the caller',
  );
  // And the compliance door is on this path, not merely nearby.
  assert.match(src, /complianceGate\s*\(/, 'every batch item must go through the advertising gate');
});

test('a batch cannot be run without a signature the server issued', () => {
  const route = ROUTES.find((r) => r.path === 'app/api/assistant/route.ts');
  assert.ok(route, 'expected the assistant route to exist');
  // The session round-trips through the browser. A pendingBatch that is acted
  // on without verification is a forged list of posts plus the word "yes".
  assert.match(route!.source, /batchIsAuthentic\s*\(/, 'pendingBatch must be verified before it runs');
  assert.match(route!.source, /signBatch\s*\(/, 'pendingBatch must be signed on the way out');
  // SPENT before the work, not merely cleared.
  //
  // The first version of this asserted that `session.pendingBatch = null` sat
  // immediately above `runBatch` — which is a fact about statement order, not
  // about safety, and it was satisfied by code that protected nothing: the
  // session round-trips through the browser, so clearing the server's copy
  // leaves the client holding a still-valid signed ticket it can re-post.
  const claimAt = route!.source.indexOf('claimBatch(');
  const runAt = route!.source.indexOf('await runBatch(');
  assert.ok(claimAt > -1, 'the batch ticket must be claimed single-use before it runs');
  assert.ok(runAt > -1, 'expected runBatch to be called');
  assert.ok(claimAt < runAt, 'the ticket must be claimed BEFORE the work, or a concurrent replay gets past it');
});

test('a batch ticket is single-use and its optional fields are signed', () => {
  // Guards the two ways past the gate the audit found. Behavioural, not a grep:
  // lib/assistant-token.ts is importable by the test runner precisely so this
  // can be checked rather than asserted about its source text.
  const tokenSrc = readFileSync(join(WEB_ROOT, 'lib', 'assistant-token.ts'), 'utf8');
  assert.doesNotMatch(tokenSrc, /^import 'server-only';/m,
    'marking it server-only is what put the consent gate outside the test runner');
  assert.match(tokenSrc, /jti/, 'a ticket needs an identity to be spendable once');
  // The encoding itself — absent must not sign the same as empty — is checked
  // behaviourally in lib/assistant-token.test.ts. Not grepped for here: the
  // first attempt matched the comment that EXPLAINS the old bug, which is the
  // standing hazard with asserting against source text.
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

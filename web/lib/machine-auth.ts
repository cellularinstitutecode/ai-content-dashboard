// Does a request carry a REAL machine credential for a specific path?
//
// This used to live inline in middleware.ts and test header PRESENCE:
//
//   req.headers.has('authorization') || req.headers.has('x-opus-signature') ...
//
// on any of the three machine paths. Presence proves nothing. `Authorization:
// Bearer anything` skipped the session check AND the tenant allowlist, so an
// authenticated but non-allowlisted account could POST /api/metricool/sync -
// which falls back to plain session auth and re-checks nothing - and have the
// clinic's org-wide Metricool analytics copied into rows it owns.
//
// Extracted into its own module so the rule is a pure function over headers and
// can be tested as a table (see machine-auth.test.ts). Nothing about middleware
// needs to be running for that table to catch a regression.

/** The subset of `Headers` this check needs. Keeps the module free of next/server. */
export interface HeaderLike {
  get(name: string): string | null;
  has(name: string): boolean;
}

export const MACHINE_PATHS = [
  '/api/opus/webhook',
  '/api/metricool/sync',
  '/api/autopilot/tick',
] as const;

export function isMachinePath(pathname: string): boolean {
  return (MACHINE_PATHS as readonly string[]).includes(pathname);
}

/**
 * True only when the request carries a credential this path actually accepts.
 *
 * A `false` result does NOT mean "reject" - it means "this is not machine
 * traffic, so apply the normal session and allowlist checks". That distinction
 * is the whole fix: the old code returned early on a guess.
 *
 * @param cronSecret process.env.CRON_SECRET, passed in so this stays pure.
 */
export function isMachineRequest(
  pathname: string,
  headers: HeaderLike,
  cronSecret: string | undefined,
): boolean {
  // Opus signs its webhook body with an HMAC that the route itself verifies -
  // timing-safe, with a freshness window and a replay guard. Letting an
  // unauthenticated request reach that check is the point: the route is the gate,
  // and it answers 401 to anything it cannot verify.
  if (pathname === '/api/opus/webhook') {
    return headers.has('x-opus-signature');
  }

  // The two Vercel crons authenticate with a bearer token. Compare the VALUE, so
  // a forged header cannot buy a trip past the allowlist.
  if (pathname === '/api/metricool/sync' || pathname === '/api/autopilot/tick') {
    if (!cronSecret) return false;
    return headers.get('authorization') === 'Bearer ' + cronSecret;
  }

  return false;
}

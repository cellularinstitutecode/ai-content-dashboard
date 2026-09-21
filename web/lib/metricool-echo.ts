// web/lib/metricool-echo.ts
// May a post go out on a link Metricool handed straight back?
//
// Pure and on its own, because lib/metricool.ts imports through `@/` aliases
// and the test runner cannot load it — and a switch whose wrong setting
// publishes a reel with no video in it is not one to leave untested.
/**
 * May a post go out on a link Metricool handed straight back?
 *
 * See the long note in normalizeMediaList in lib/metricool.ts. Unset, misspelt or anything other than
 * an explicit yes leaves the refusal exactly where it has always been.
 */
export function acceptEcho(env: Record<string, string | undefined> = process.env): boolean {
  const raw = String(env.METRICOOL_ACCEPT_ECHO ?? '').trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
}


// One way to say "this failed, and we carried on anyway".
//
// The house style across this codebase is fail-soft, and that instinct is right:
// a brand-profile lookup that errors should not take down generation. The
// problem was the silence. There are 250 catch clauses in the app and 7 of them
// logged anything, so a degraded path and a healthy path looked identical from
// outside - which is how a Metricool post could succeed while its local `posts`
// row silently failed, leaving the calendar disagreeing with reality and no
// trace of why.
//
// `reportError` keeps the behaviour and removes the silence. It is deliberately
// dependency-free: swap the body for Sentry (or whatever you adopt) in one place
// and every call site starts reporting.
//
// One honest limit: converting `catch {}` only surfaces failures that actually
// THROW. supabase-js returns `{ data, error }` rather than throwing, so a query
// against a missing table still fails quietly - the `error` field is discarded
// on the line above the catch. Those call sites need their own pass; this module
// is the place to send them when you make it.

type Context = Record<string, unknown>;

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Record a non-fatal failure. The caller has already decided to continue; this
 * only makes the decision visible.
 *
 * @param scope  where it happened, e.g. 'generate:brand-load'
 * @param err    whatever was caught
 * @param ctx    small, non-sensitive extras (ids, counts - never tokens or post text)
 */
export function reportError(scope: string, err: unknown, ctx?: Context): void {
  const line = `[${scope}] ${describe(err)}`;
  if (ctx && Object.keys(ctx).length) {
    console.error(line, ctx);
  } else {
    console.error(line);
  }
  // Wire your error tracker here - it is the only edit needed to send every
  // fail-soft path in the app to a dashboard:
  //   Sentry.captureException(err, { tags: { scope }, extra: ctx });
}

/**
 * Await a promise, returning `fallback` instead of throwing - and reporting on
 * the way past. Use where the old code read `try { ... } catch {}`.
 */
export async function soft<T>(
  scope: string,
  work: () => Promise<T>,
  fallback: T,
  ctx?: Context,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    reportError(scope, err, ctx);
    return fallback;
  }
}

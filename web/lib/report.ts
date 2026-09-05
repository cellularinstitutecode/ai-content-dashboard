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

// Secrets that vendors echo back in error bodies. One of them was real: the
// Semrush balance endpoint answers a v4 key with an HTML page that quotes the
// key, and `semrush:balance-unreadable` logged a sample of that page — so the
// key sat in Vercel's logs. Every message and every string in the context now
// passes through this before it is written anywhere.
const SECRET_PATTERNS: RegExp[] = [
  /semrtkn-[A-Za-z0-9_-]{6,}/g, // Semrush v4 tokens
  /sk-[A-Za-z0-9_-]{12,}/g, // OpenAI-style keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs (Supabase)
  /(?<=\b(?:key|token|apikey|api_key|secret|password|authorization)=)[^&\s"'<>]+/gi, // query/body params
  /(?<=\b(?:Bearer|Apikey)\s)[A-Za-z0-9._-]{8,}/g, // auth headers
  /\b[0-9a-f]{32,}\b/gi, // long hex (v3 keys, service tokens)
];

/** Mask anything that looks like a credential. Exported for tests and for callers that log on their own. */
export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

function redactContext(ctx: Context): Context {
  const out: Context = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

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
  const line = `[${scope}] ${redact(describe(err))}`;
  if (ctx && Object.keys(ctx).length) {
    console.error(line, redactContext(ctx));
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

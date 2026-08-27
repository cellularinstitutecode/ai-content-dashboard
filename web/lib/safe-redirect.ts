// One implementation of "is this ?next= destination safe to send a browser to".
//
// There were two, both written as `next.startsWith('/') && !next.startsWith('//')`,
// and both wrong in the same way: a backslash slips straight through.
// `new URL('/\\evil.com', 'https://app.example.com')` resolves to
// `https://evil.com/`, and browsers normalise the backslash identically when the
// value is handed to `window.location.href`. That turns the moment right after a
// successful sign-in - the most convincing moment there is - into a redirect to
// an attacker's page.
//
// Pattern-matching the string is the wrong shape for this check. Resolve the
// candidate against the real origin and compare origins; anything that escapes,
// for any reason the URL parser recognises, fails.

/**
 * Resolve a caller-supplied `next` destination to a same-origin path.
 * Returns a path beginning with '/', falling back to '/' for anything that does
 * not stay on `origin`.
 */
export function safeNextPath(next: unknown, origin: string): string {
  if (typeof next !== 'string' || next === '') return '/';

  // Reject control characters outright: browsers strip some of them before
  // parsing, so what the URL parser sees and what the browser navigates to can
  // differ. Nothing in this range belongs in a path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(next)) return '/';

  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return '/';
  }

  let target: URL;
  try {
    target = new URL(next, base);
  } catch {
    return '/';
  }

  if (target.origin !== base.origin) return '/';
  return target.pathname + target.search + target.hash;
}

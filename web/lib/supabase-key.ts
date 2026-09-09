// Which Supabase key is in SUPABASE_SERVICE_ROLE_KEY — read from the key itself.
//
// This exists because of a failure mode with no symptom. brand_profiles has
// row-level security: a user may read their own row and no one else's. The
// service role BYPASSES that policy; the anon key does not. So a deployment
// holding the anon key under the name SUPABASE_SERVICE_ROLE_KEY behaves like
// this:
//
//   • Brand Brain saves perfectly. That write goes through the signed-in
//     user's own session, and the policy passes.
//   • Every server-side read of the same row returns ZERO ROWS. No error, no
//     exception — the policy simply matches nothing without a user.
//
// Which reads, from the outside, as "nobody ever saved a Brand Brain." The two
// keys are both long JWTs beginning `eyJ`, sit next to each other in the
// Supabase dashboard, and are copied by hand into Vercel. Mixing them up is
// one wrong paste, and nothing anywhere says so.
//
// A Supabase legacy key IS a JWT, and its payload names its own role, so this
// can be answered locally: no network call, and no part of the key is ever
// returned or logged.

export type KeyRole = 'service_role' | 'anon' | 'other' | 'unknown';

/**
 * The role a Supabase key carries.
 *
 * 'unknown' is honest rather than lazy: the newer `sb_secret_…` /
 * `sb_publishable_…` formats are opaque strings that cannot be decoded, and
 * guessing at one would put this check back in the business of speculation.
 */
export function keyRole(key: string | undefined | null): KeyRole {
  const raw = String(key || '').trim();
  if (!raw) return 'unknown';

  // Newer key formats say what they are in the prefix.
  if (/^sb_secret_/.test(raw)) return 'service_role';
  if (/^sb_publishable_/.test(raw)) return 'anon';

  const parts = raw.split('.');
  if (parts.length !== 3) return 'unknown';
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const role = (JSON.parse(json) as { role?: unknown }).role;
    if (role === 'service_role') return 'service_role';
    if (role === 'anon') return 'anon';
    return typeof role === 'string' && role ? 'other' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * What to tell a person about the key under SUPABASE_SERVICE_ROLE_KEY.
 *
 * Only the anon key is reported as wrong, and it is reported as wrong loudly,
 * because it is the one mix-up that leaves the app looking healthy while every
 * privileged read comes back empty.
 */
export function serviceKeyVerdict(key: string | undefined | null): { ok: boolean; code?: string; detail: string } {
  if (!String(key || '').trim()) {
    return { ok: false, code: 'missing', detail: 'SUPABASE_SERVICE_ROLE_KEY is not set. Every server-side read and write that runs without a signed-in user — the video sweep, Autopilot, the Metricool sync — has no credential at all.' };
  }
  switch (keyRole(key)) {
    case 'service_role':
      return { ok: true, detail: 'SUPABASE_SERVICE_ROLE_KEY carries the service role, so server-side reads see every row regardless of row-level security.' };
    case 'anon':
      return {
        ok: false,
        code: 'anon_key',
        detail:
          'SUPABASE_SERVICE_ROLE_KEY holds the ANON key, not the service-role key. ' +
          'Row-level security then applies to every background job: saving Brand Brain works (that write carries your session) ' +
          'while the sweep reading it back gets zero rows and reports that nobody ever saved one. ' +
          'Copy the service_role key from Supabase → Project Settings → API and redeploy.',
      };
    case 'other':
      return { ok: false, code: 'wrong_role', detail: 'SUPABASE_SERVICE_ROLE_KEY holds a key whose role is neither service_role nor anon. Server-side reads will see only what that role is permitted to see.' };
    default:
      return { ok: true, code: 'unreadable', detail: 'SUPABASE_SERVICE_ROLE_KEY is set in a format whose role cannot be read locally. If privileged reads come back empty, check that it is the service_role key and not the anon key.' };
  }
}

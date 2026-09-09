// Who the sweep writes as — and, when the answer is nobody, WHY.
//
// This was one line inside video-autopilot.ts, and it lied. It looked for a
// brand_profiles row, ignored the `error` half of what Supabase returned, and
// treated anything that was not a row as "no Brand Brain has been saved". But
// supabase-js RESOLVES on a failed query rather than throwing, so the
// try/catch around it caught nothing and reported nothing:
//
//   a wrong service-role key      → error, data null → "no Brand Brain saved"
//   row-level security applying   → no error, 0 rows → "no Brand Brain saved"
//   the table genuinely empty     → no error, 0 rows → "no Brand Brain saved"
//
// Three different problems, one message, and the message named the only one
// the person could not fix — so the advice was "press Save on a page you have
// already saved". This module keeps the three apart and says which it is.
import 'server-only';

import { isAllowedEmail } from '@/lib/access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { keyRole } from '@/lib/supabase-key';
import { reportError } from '@/lib/report';

export type OwnerSource = 'env' | 'brand_profile' | 'allowlist';

export type OwnerResult =
  | { ok: true; userId: string; source: OwnerSource; brandProfile: boolean; detail: string }
  | {
      ok: false;
      /**
       * empty        — the queries worked and there is genuinely nothing there.
       * unreadable   — a query FAILED. Nothing can be concluded about the data.
       * rls_blocked  — the credential cannot see past row-level security.
       */
      reason: 'empty' | 'unreadable' | 'rls_blocked';
      detail: string;
    };

/**
 * The account the automatic sweep acts as.
 *
 * In order of preference: an explicit override, the saved Brand Brain (best,
 * because it is the clinic's voice as well as an owner), then the first
 * allowlisted account — the sheet belongs to the workspace, not to a person,
 * so an unsaved Brand Brain should cost the copy its voice, not stop the run.
 */
export async function resolveOwner(): Promise<OwnerResult> {
  const explicit = process.env.VIDEO_AUTOPILOT_USER_ID;
  if (explicit) {
    return { ok: true, userId: explicit, source: 'env', brandProfile: false, detail: 'VIDEO_AUTOPILOT_USER_ID is set and overrides everything else.' };
  }

  const sb = supabaseAdmin();
  const anonKey = keyRole(process.env.SUPABASE_SERVICE_ROLE_KEY) === 'anon';

  const brand = await sb
    .from('brand_profiles')
    .select('user_id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const owner = (brand.data as { user_id?: string } | null)?.user_id;
  if (owner) {
    return { ok: true, userId: owner, source: 'brand_profile', brandProfile: true, detail: 'Writing as the account that saved Brand Brain.' };
  }

  // A failed query is NOT an empty table, and conflating them is what sent a
  // person back to a page they had already saved.
  if (brand.error) {
    reportError('sweep-owner:brand', brand.error);
    if (anonKey) {
      return { ok: false, reason: 'rls_blocked', detail: brandUnreadableByAnon(brand.error.message) };
    }
    return {
      ok: false,
      reason: 'unreadable',
      detail: 'brand_profiles could not be read: ' + (brand.error.message || 'unknown error') + '. This is a database or credential problem, not a missing Brand Brain.',
    };
  }

  // No error and no row. With the anon key that means nothing at all: RLS
  // hides every row from a request with no signed-in user, so "zero rows" and
  // "no rows exist" are indistinguishable — and saying "nobody saved one"
  // would be a claim this cannot support.
  if (anonKey) {
    return { ok: false, reason: 'rls_blocked', detail: brandUnreadableByAnon(null) };
  }

  const users = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (users.error) {
    reportError('sweep-owner:users', users.error);
    return {
      ok: false,
      reason: 'unreadable',
      detail: 'No Brand Brain row, and the account list could not be read either: ' + (users.error.message || 'unknown error') +
        '. Check SUPABASE_SERVICE_ROLE_KEY — listing accounts needs the service role.',
    };
  }

  const allowed = (users.data?.users || [])
    .filter((u) => isAllowedEmail(u.email ?? null))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const first = allowed[0]?.id;
  if (first) {
    return {
      ok: true,
      userId: first,
      source: 'allowlist',
      brandProfile: false,
      detail: 'No Brand Brain saved, so the copy uses the default voice. Writing as the first allowlisted account.',
    };
  }

  return {
    ok: false,
    reason: 'empty',
    detail: 'There is genuinely no Brand Brain row and no allowlisted account in this database. Sign in to the dashboard once, then save Brand Brain.',
  };
}

function brandUnreadableByAnon(message: string | null): string {
  return (
    'SUPABASE_SERVICE_ROLE_KEY holds the ANON key, so this read is subject to row-level security and returns nothing ' +
    'whether or not a Brand Brain exists' + (message ? ' (' + message + ')' : '') + '. ' +
    'Saving Brand Brain works — that write carries your own session — which is why it looks saved and unsaved at the same time. ' +
    'Replace it with the service_role key from Supabase → Project Settings → API.'
  );
}

/** The account id alone, for callers that only need somebody to write as. */
export async function resolveSweepUser(): Promise<string | null> {
  const r = await resolveOwner();
  return r.ok ? r.userId : null;
}

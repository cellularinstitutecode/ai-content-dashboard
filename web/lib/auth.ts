import 'server-only';
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { isAllowedEmail } from '@/lib/access';

// One place that answers "may this caller do anything here at all".
//
// Authorization used to be re-derived in roughly twenty route handlers, each
// spelling out `supabaseServer()` -> `getUser()` -> `if (!user) 401`. None of
// them re-checked the tenant allowlist, because middleware was assumed to have
// done it. When middleware grew a machine-path exemption, that assumption
// quietly became false for three routes and nothing downstream noticed - which
// is exactly the shape of bug a shared helper prevents.
//
// Routes that call `requireAllowlistedUser()` are correct whatever middleware
// does or stops doing.

export type AuthOk = { ok: true; userId: string; email: string | null };
export type AuthFail = { ok: false; response: NextResponse };
export type AuthResult = AuthOk | AuthFail;

const NO_STORE = { 'cache-control': 'no-store' } as const;

function unauthorized(): AuthFail {
  return {
    ok: false,
    response: NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: NO_STORE },
    ),
  };
}

function forbidden(): AuthFail {
  return {
    ok: false,
    response: NextResponse.json(
      { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
      { status: 403, headers: NO_STORE },
    ),
  };
}

/**
 * Require a signed-in Supabase user. Fails CLOSED: if the auth check itself
 * throws, the caller gets a 401 rather than an open door.
 */
export async function requireUser(): Promise<AuthResult> {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return unauthorized();
    return { ok: true, userId: user.id, email: user.email ?? null };
  } catch {
    return unauthorized();
  }
}

/**
 * Require a signed-in user whose email is on the workspace allowlist.
 *
 * Use this for anything that reaches a shared resource - the org-wide Metricool
 * account, the clinic's Semrush units, the Drive folder - where "is this a
 * valid session" is a weaker question than "is this one of our people".
 */
export async function requireAllowlistedUser(): Promise<AuthResult> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  if (!isAllowedEmail(auth.email)) return forbidden();
  return auth;
}

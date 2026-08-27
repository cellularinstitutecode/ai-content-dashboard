import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { safeNextPath } from '@/lib/safe-redirect';
import { isAllowedEmail } from '@/lib/access';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/';

  if (!code) {
    return NextResponse.redirect(new URL('/sign-in?error=missing_code', url.origin));
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: any) {
          cookieStore.set({ name, value: '', ...options, maxAge: 0 });
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    return NextResponse.redirect(new URL('/sign-in?error=exchange_failed', url.origin));
  }

  // Same allowlist the middleware uses - lib/access.ts is the single source.
  // This used to be a second, separately-parsed copy of the same env vars.
  if (!isAllowedEmail(data.user.email)) {
    // Defense in depth: even if a stranger got a magic link, kick them out.
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/sign-in?error=not_allowed', url.origin));
  }

  // `next` is attacker-controllable. Containment is an origin comparison, not a
  // string prefix test - see lib/safe-redirect.ts for why the prefix test failed.
  return NextResponse.redirect(new URL(safeNextPath(next, url.origin), url.origin));
}

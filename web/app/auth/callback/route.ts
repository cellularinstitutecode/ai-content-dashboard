import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const ALLOWED = (process.env.ALLOWED_EMAILS || process.env.NEXT_PUBLIC_ALLOWED_EMAILS || 'cellularhopeinstitute@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/';

  if (!code) {
    return NextResponse.redirect(new URL('/sign-in?error=missing_code', url.origin));
  }

  const cookieStore = cookies();
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

  const email = (data.user.email || '').toLowerCase();
  if (!ALLOWED.includes(email)) {
    // Defense in depth: even if a stranger got a magic link, kick them out.
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/sign-in?error=not_allowed', url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}

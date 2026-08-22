import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Only enforce auth on app routes; let the sign-in/auth flows pass.
  // Exact-or-segment matching: '/auth/...' yes, '/authanything' no.
  const { pathname } = req.nextUrl;
  const openPrefixes = ['/sign-in', '/sign-up', '/auth'];
  if (openPrefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return res;
  }

  // Machine endpoints authenticate themselves (CRON_SECRET bearer / Opus HMAC
  // signature) and are called without a browser session. Session auth here
  // would 307 them to /sign-in before their own checks ever run, silently
  // killing the daily crons and the Opus completion webhook.
  if (
    pathname === '/api/opus/webhook' ||
    pathname === '/api/metricool/sync' ||
    pathname === '/api/autopilot/tick'
  ) {
    return res;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return req.cookies.get(name)?.value; },
        set(name: string, value: string, options: CookieOptions) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          res.cookies.set({ name, value: '', ...options });
        }
      }
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)']
}

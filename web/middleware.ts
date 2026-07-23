import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const TEMP_PASSWORD = process.env.TEMP_PASSWORD || '123456789';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Only enforce auth on app routes; let /sign-in and /api/public pass.
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/sign-in') || pathname.startsWith('/sign-up') || pathname.startsWith('/auth') || pathname.startsWith('/api/public')) {
    return res;
  }

  // Temporary password-based auth: a valid app_auth cookie grants access.
  const appAuth = req.cookies.get('app_auth')?.value;
  if (appAuth && appAuth === TEMP_PASSWORD) {
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\..*).*)']
};

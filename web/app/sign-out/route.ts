import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

async function signOut(request: Request) {
  const url = new URL(request.url);
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

  await supabase.auth.signOut();

  const res = NextResponse.redirect(new URL('/sign-in', url.origin));
  // Clear the temporary password auth cookie as well.
  res.cookies.set({ name: 'app_auth', value: '', path: '/', maxAge: 0 });
  return res;
}

export async function POST(request: Request) {
  return signOut(request);
}

export async function GET(request: Request) {
  return signOut(request);
}

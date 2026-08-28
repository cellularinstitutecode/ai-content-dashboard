import { createBrowserClient, createServerClient, type CookieOptions } from '@supabase/ssr';

export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ASYNC since Next 15: cookies() returns a promise, so this factory does too.
// Every caller needs `await supabaseServer()`.
//
// Note for whoever upgrades next: the `require()` below hides this call from
// the type checker. `tsc` flagged the six direct `cookies()` uses in
// app/auth/callback and app/sign-out and said nothing about this one - fix only
// what tsc reports and you get a green typecheck with a runtime that hands
// every route a Promise where it expects a client. The require() is kept
// because a top-level `import` of next/headers pulls server-only code into any
// module that touches this file.
export async function supabaseServer() {
  const { cookies } = require("next/headers");
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return store.get(name)?.value; },
        set(name: string, value: string, options: CookieOptions) {
          try { store.set({ name, value, ...options }); } catch {}
        },
        remove(name: string, options: CookieOptions) {
          try { store.set({ name, value: '', ...options }); } catch {}
        }
      }
    }
  );
}

// The service-role client now lives in lib/supabase-admin.ts, which is
// marked `server-only`. Re-exporting it from here would defeat that guard, so
// server code imports it from its own module:
//   import { supabaseAdmin } from '@/lib/supabase-admin';

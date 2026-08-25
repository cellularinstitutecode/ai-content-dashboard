import { createBrowserClient, createServerClient, type CookieOptions } from '@supabase/ssr';

export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export function supabaseServer() {
  const { cookies } = require("next/headers");
  const store = cookies();
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

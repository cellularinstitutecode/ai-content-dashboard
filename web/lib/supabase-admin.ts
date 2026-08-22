import 'server-only';
import { createClient } from '@supabase/supabase-js';

// Service-role client for trusted server-side ops (drafts/posts writes).
//
// This lives in its own module with `import 'server-only'` so that importing
// it from a client component is a BUILD error rather than a shipped key.
// It used to sit beside supabaseBrowser(), which is imported by
// components/LiveContentProvider.tsx — a "use client" file — leaving nothing
// to stop a future client component from reaching the service-role factory.
export function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

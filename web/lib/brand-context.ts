// web/lib/brand-context.ts
// The clinic's Brand Brain, loaded the same way by everything that writes.
//
// This block lived inline in app/api/generate/route.ts and nowhere else. So a
// post written from the dashboard carried the clinic's voice, its audience and
// its advertising-notice number, and the identical request typed into the chat
// window carried none of them — the assistant never loaded a profile at all.
// Same brand, same user, same sentence asked two ways, two different results,
// and nothing on screen to suggest why.
//
// It also matters beyond voice: complianceGate reads `aviso_publicidad`, so a
// draft generated without the profile is refused at the Metricool door for
// missing a notice the profile would have supplied.
import 'server-only';

import type { BrandContext } from '@/lib/ai';

/** The columns a generator actually reads. Kept explicit so adding one is a decision. */
const BRAND_COLUMNS = 'name, mission, voice, audience, keywords, guidelines, aviso_publicidad';

/**
 * Any Supabase client. Deliberately not the real `SupabaseClient` type: both
 * callers pass a differently-parameterised one, and matching them structurally
 * sends the compiler into an unbounded instantiation. What this function needs
 * from a client is one query, and that is all it asks for.
 */
type Queryable = { from: (table: string) => any };

/**
 * The signed-in user's brand profile, or undefined.
 *
 * Undefined rather than throwing, on purpose: a brand profile is optional and
 * every generator has a default voice to fall back on. Failing to load one is
 * a quieter post, not a failed request.
 *
 * @param sb any Supabase client — the caller decides whether that is the
 *   request-scoped server client or the service-role one.
 */
export async function loadBrandContext(sb: Queryable, userId: string): Promise<BrandContext | undefined> {
  try {
    const { data } = await sb.from('brand_profiles').select(BRAND_COLUMNS).eq('user_id', userId).maybeSingle();
    return data ? (data as BrandContext) : undefined;
  } catch {
    // Fall back to the default brand voice.
    return undefined;
  }
}

// web/app/api/brand/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { normalizeVisual } from '@/lib/brand-visual';
import { isMissingSchema } from '@/lib/schema-probe';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// GET /api/brand
// Returns the signed-in user's Brand Brain profile (voice, audience, guidelines).
export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await sb
    .from('brand_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brand: data ?? null });
}

// POST /api/brand
// Creates or updates the user's Brand Brain profile (one row per user).
export async function POST(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { name, mission, voice, audience, keywords, guidelines, aviso_publicidad, visual } = body || {};

  const payload = {
    user_id: user.id,
    name: (name ?? '').toString().slice(0, 200),
    mission: (mission ?? '').toString(),
    voice: (voice ?? '').toString(),
    audience: (audience ?? '').toString(),
    keywords: Array.isArray(keywords) ? keywords : [],
    guidelines: (guidelines ?? '').toString(),
    // Permit numbers are letters and digits only; anything else is a typo.
    aviso_publicidad: (aviso_publicidad ?? '').toString().replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 40),
    // Stored normalized: bad colours dropped, blanks filled from the brand
    // guide, lengths capped — so what the image pipeline reads is always whole.
    visual: normalizeVisual(visual),
    updated_at: new Date().toISOString(),
  };

  let { data, error } = await sb
    .from('brand_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select()
    .maybeSingle();
  // A database behind supabase/schema.sql must still save what it CAN.
  //
  // This handled `visual` by name and nothing else, which was a guess about
  // which column would go missing — and the one that actually did was
  // updated_at, written on every save a few lines above. A database without it
  // refuses the entire upsert, so the whole profile is lost over a timestamp,
  // and on screen that is indistinguishable from a save that did not stick.
  //
  // Postgres names the column it refused. Drop that one and try again, rather
  // than keeping a list of the columns somebody thought to predict.
  let warning: string | null = null;
  if (error && isMissingSchema(error.code)) {
    const refused = Object.keys(payload).find((k) => new RegExp('\\b' + k + '\\b').test(error?.message || ''));
    if (refused) {
      const rest: Record<string, unknown> = { ...payload };
      delete rest[refused];
      ({ data, error } = await sb.from('brand_profiles').upsert(rest, { onConflict: 'user_id' }).select().maybeSingle());
      warning = refused === 'visual'
        ? 'Saved without the visual identity: run supabase/schema.sql to add the brand_profiles.visual column.'
        : 'Saved, but this database has no brand_profiles.' + refused + ' column — run supabase/schema.sql to add it.';
    }
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brand: data, warning });
}

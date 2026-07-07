// web/app/api/brand/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// GET /api/brand
// Returns the signed-in user's Brand Brain profile (voice, audience, guidelines).
export async function GET() {
  const sb = supabaseServer();
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
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { name, mission, voice, audience, keywords, guidelines } = body || {};

  const payload = {
    user_id: user.id,
    name: (name ?? '').toString().slice(0, 200),
    mission: (mission ?? '').toString(),
    voice: (voice ?? '').toString(),
    audience: (audience ?? '').toString(),
    keywords: Array.isArray(keywords) ? keywords : [],
    guidelines: (guidelines ?? '').toString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('brand_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brand: data });
}

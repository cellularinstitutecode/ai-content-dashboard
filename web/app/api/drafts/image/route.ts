// web/app/api/drafts/image/route.ts
// POST { id } → generate (or return the existing) AI hero image for one of
// the signed-in user's drafts and stamp it on the draft's pack as `_image`.
//
// Called by the dashboard right after a pack is generated (so the text shows
// instantly and the image fills in when ready) and by the Autopilot queue for
// ready-for-review runs that don't have an image yet. Idempotent: a draft
// that already carries `_image` returns it without spending anything.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { generatePackImage, imagesEnabled, type PackImage } from '@/lib/images';
import { checkRateLimit } from '@/lib/rate-limit';
import type { BrandContext } from '@/lib/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    if (!imagesEnabled()) {
      return NextResponse.json(
        { error: 'image generation disabled (set OPENAI_API_KEY, or remove IMAGE_GEN=off)' },
        { status: 503 }
      );
    }

    // RLS scopes this select to the owner — no draft, no image.
    const { data: d } = await sb.from('drafts').select('id, topic, pack').eq('id', id).maybeSingle();
    if (!d) return NextResponse.json({ error: 'draft not found' }, { status: 404 });

    const pack = (d as { pack?: Record<string, unknown> }).pack || {};
    if ((pack as { kind?: string }).kind === 'clip') {
      return NextResponse.json({ error: 'clip drafts already have video stills' }, { status: 400 });
    }
    const existing = (pack as { _image?: PackImage })._image;
    if (existing?.url) return NextResponse.json({ image: existing, cached: true });

    // Rate limit only when we are actually about to spend image credits.
    const rl = await checkRateLimit(user.id, 'image');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    // Brand profile keeps the image on-brand (optional, fail-soft).
    let brand: BrandContext | undefined;
    try {
      const { data: bp } = await sb
        .from('brand_profiles')
        .select('name, mission, voice, audience, keywords, guidelines')
        .eq('user_id', user.id)
        .maybeSingle();
      if (bp) brand = bp as BrandContext;
    } catch { /* optional */ }

    const image = await generatePackImage({
      topic: String((d as { topic?: string }).topic || 'regenerative medicine'),
      pack,
      brand,
    });

    // Owner update passes RLS via the session client.
    const { error } = await sb.from('drafts').update({ pack: { ...pack, _image: image } }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ image });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'image generation failed' },
      { status: 500 }
    );
  }
}

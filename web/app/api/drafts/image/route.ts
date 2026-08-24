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
    // regenerate: true → discard the current image and produce a fresh take
    // with the NEXT composition variant, so the reviewer always gets a
    // visibly different proposition (never a re-roll of the same prompt).
    const regenerate = body?.regenerate === true;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    // Scoped explicitly to the owner as well as by RLS — every sibling route
    // (drafts, posts, templates, brand) does both, and this was the only
    // draft read/write in the codebase relying on RLS alone.
    const { data: d } = await sb
      .from('drafts')
      .select('id, topic, pack')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!d) return NextResponse.json({ error: 'draft not found' }, { status: 404 });

    const pack = (d as { pack?: Record<string, unknown> }).pack || {};
    if ((pack as { kind?: string }).kind === 'clip') {
      return NextResponse.json({ error: 'clip drafts already have video stills' }, { status: 400 });
    }
    const existing = (pack as { _image?: PackImage })._image;
    // A stored image the checker marked as containing text is never good
    // enough to serve as "done": content images must be text-free, so treat
    // it like a regenerate request (next composition variant) instead.
    const existingHasText = existing?.verification?.textDetected === true;
    if (existing?.url && !regenerate && !existingHasText) {
      return NextResponse.json({ image: existing, cached: true });
    }
    const advanceVariant = regenerate || existingHasText;

    // Only NOW check whether generation is available: a draft that already
    // carries a clean verified image must return it even when the OpenAI key
    // is missing — the old order 503'd on cached images too, so the gallery
    // showed an error for images that already existed.
    if (!imagesEnabled()) {
      return NextResponse.json(
        { error: 'image generation disabled (set OPENAI_API_KEY, or remove IMAGE_GEN=off)' },
        { status: 503 }
      );
    }

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
      // Fresh generations start at variant 0; each regenerate (explicit, or
      // forced by a text-flagged stored image) advances to the next
      // composition (hero shot → macro lab → lifestyle → still-life → …).
      variant: advanceVariant ? (existing?.variant ?? 0) + 1 : 0,
    });

    // Owner update passes RLS via the session client.
    const { error } = await sb
      .from('drafts')
      .update({ pack: { ...pack, _image: image } })
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ image });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'image generation failed' },
      { status: 500 }
    );
  }
}

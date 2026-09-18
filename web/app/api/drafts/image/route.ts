// web/app/api/drafts/image/route.ts
// POST { id } → generate (or return the existing) AI hero image for one of
// the signed-in user's drafts and stamp it on the draft's pack as `_image`.
//
// Called by the dashboard right after a pack is generated (so the text shows
// instantly and the image fills in when ready) and by the Autopilot queue for
// ready-for-review runs that don't have an image yet. Idempotent: a draft
// that already carries `_image` returns it without spending anything.
import { isAllowedEmail } from '@/lib/access';
import { decodeDataUrl } from '@/lib/data-url';
import { reportError } from '@/lib/report';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { generatePackImage, imagesEnabled, removeSuperseded, storeBytes, type PackImage } from '@/lib/images';
import { checkRateLimit } from '@/lib/rate-limit';
import type { BrandContext } from '@/lib/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    // Spends the clinic's OpenAI image credits, so the allowlist applies.
    if (!isAllowedEmail(user.email)) {
      return NextResponse.json(
        { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id : '';
    // regenerate: true → discard the current image and produce a fresh take
    // with the NEXT composition variant, so the reviewer always gets a
    // visibly different proposition (never a re-roll of the same prompt).
    const regenerate = body?.regenerate === true;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    // A PHOTO, OR A DIRECTION — because "press New image and hope" was the only
    // control there was.
    //
    //   direction  what the team wants the picture to be, in their own words.
    //   useUrl     a real photograph already in the clinic's library, used as
    //              it is. No generation, no credits, and nothing that "looks
    //              too AI" because it is not.
    //   dataUrl    a file dropped on the panel, stored in the same bucket the
    //              generated ones live in.
    const direction = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 600) : '';
    const useUrl = typeof body?.useUrl === 'string' ? body.useUrl.trim() : '';
    const dataUrl = typeof body?.dataUrl === 'string' ? body.dataUrl : '';
    const givenAlt = typeof body?.alt === 'string' ? body.alt.trim().slice(0, 300) : '';

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
    // A PHOTOGRAPH THE CLINIC CHOSE. Saved as the hero image exactly as given —
    // no generation, no verification: the text rule exists because an image
    // MODEL writes gibberish signage, and a real photograph of the clinic is
    // not that. It is their picture; they have seen it.
    if (useUrl || dataUrl) {
      let url = useUrl;
      let source: 'library' | 'upload' = 'library';
      if (!url) {
        const decoded = decodeDataUrl(dataUrl);
        if (!decoded.ok) return NextResponse.json({ error: 'bad_image', message: decoded.message }, { status: 400 });
        url = await storeBytes(decoded.bytes, decoded.contentType, decoded.ext, 'upload');
        source = 'upload';
      } else if (!/^https:\/\/\S+$/i.test(url)) {
        return NextResponse.json({ error: 'bad_image', message: 'That image address is not one a network can fetch.' }, { status: 400 });
      }
      const chosen = {
        url,
        prompt: direction || '',
        alt: givenAlt || 'Photograph chosen by the clinic',
        model: source === 'upload' ? 'uploaded' : 'library',
        createdAt: new Date().toISOString(),
        variant: 0,
        source,
      };
      const { data: freshRow } = await sb.from('drafts').select('pack').eq('id', id).eq('user_id', user.id).maybeSingle();
      const currentPack = (freshRow as { pack?: Record<string, unknown> } | null)?.pack ?? pack;
      const { error: setErr } = await sb.from('drafts').update({ pack: { ...currentPack, _image: chosen } })
        .eq('id', id).eq('user_id', user.id);
      if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });
      return NextResponse.json({ image: chosen });
    }

    const existingHasText = existing?.verification?.textDetected === true;
    // A direction is itself a request for a new image: somebody typed what they
    // want, and returning the cached one would answer a different question.
    if (existing?.url && !regenerate && !existingHasText && !direction) {
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
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (bp) brand = bp as BrandContext;
    } catch (err) { /* optional */ reportError('drafts-image:brand-load', err); }

    const image = await generatePackImage({
      topic: String((d as { topic?: string }).topic || 'regenerative medicine'),
      pack,
      brand,
      direction,
      // Fresh generations start at variant 0; each regenerate (explicit, or
      // forced by a text-flagged stored image) advances to the next
      // composition (hero shot → macro lab → lifestyle → still-life → …).
      variant: advanceVariant ? (existing?.variant ?? 0) + 1 : 0,
    });

    // Re-read the pack immediately before writing, and merge `_image` into the
    // FRESH copy. Generation + vision verification takes 30-60s, and the pack
    // read at the top of this handler is stale by then: if a reviewer clicked
    // "Ask for changes" in that window, stepDraft has already written a new pack
    // to this same draft, and writing back the old one silently discards the
    // rewrite they asked for - while the run log still says they asked for it.
    // Only `_image` is ours to set here; everything else belongs to whoever
    // wrote last.
    const { data: fresh } = await sb
      .from('drafts')
      .select('pack')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();
    const currentPack = (fresh as { pack?: Record<string, unknown> } | null)?.pack ?? pack;

    // Owner update passes RLS via the session client.
    const nextPack = { ...currentPack, _image: image };
    const { error } = await sb
      .from('drafts')
      .update({ pack: nextPack })
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // "New image" REPLACES. The object the draft just stopped pointing at goes
    // — after the write, so a failed write never orphans the image on screen.
    await removeSuperseded(currentPack, nextPack);

    return NextResponse.json({ image });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'image generation failed' },
      { status: 500 }
    );
  }
}

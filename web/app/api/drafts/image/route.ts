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
import { libraryHero } from '@/lib/library-hero';
import { touchLibraryUse } from '@/lib/library-index';
import { checkRateLimit } from '@/lib/rate-limit';
import { plannerImageFor } from '@/lib/planner-image';
import type { BrandContext } from '@/lib/ai';
import { imageUnshippable } from '@/lib/image-verdict';
import { cleanCoverTitle, notesOf, retitleDecision, takesOf } from '@/lib/cover-edit';
import { coverTitleFor } from '@/lib/library-cover';
import { retitleImage } from '@/lib/retitle';
import { suggestCoverTitles } from '@/lib/title-suggest';
import { briefSource } from '@/lib/image-brief';

export const runtime = 'nodejs';
// THE ARITHMETIC, as with the schedule route.
//
// lib/images.ts allows each generation attempt 50 seconds and has four rungs,
// and the vision check runs after whichever one answers — inside a 60-second
// function. So a first attempt that ran long was killed by the platform with a
// bodyless 504, and the rungs below it never ran at all. At `quality: high` a
// generation is slower still, which would have made that the ordinary case.
export const maxDuration = 300;

/**
 * GET ?id= → the draft's current picture and the title its cover would carry,
 * for the Edit image panel (components/ImageEditPanel.tsx) to open pre-filled.
 * Reads only; spends nothing.
 */
export async function GET(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = String(req.nextUrl.searchParams.get('id') || '').trim();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { data: d } = await sb.from('drafts').select('id, topic, pack').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!d) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  const pack = (d as { pack?: Record<string, unknown> }).pack || {};
  const image = (pack as { _image?: PackImage })._image ?? null;
  const planner = plannerImageFor(pack);
  return NextResponse.json({
    image,
    title: coverTitleFor(pack, (d as { topic?: string }).topic || ''),
    plannerTitle: planner?.title ?? null,
    retitle: retitleDecision(image),
  });
}

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
    // brandPhotoUrl: <library photo> → THAT photo, with the brand's colour
    // filter and the post's title on it (lib/library-hero.ts). No image model:
    // this replaced "AI image styled after a library photo", whose fresh AI
    // take was what the team did not want.
    const brandPhotoUrl = typeof body?.brandPhotoUrl === 'string' ? body.brandPhotoUrl.trim() : '';
    const regenerate = body?.regenerate === true;
    // option: true  → make ONE MORE proposition and keep it alongside the others
    //                 (the reviewer picks from several rather than rerolling blind).
    // choose: <url> → promote one of those propositions to the hero image.
    const asOption = body?.option === true;
    const askedSlot = Number.isFinite(Number(body?.slot)) ? Math.abs(Math.round(Number(body.slot))) : null;
    // options: 3 → make a whole SET of propositions in ONE request, generated
    // in parallel and written once. Three sequential requests took five minutes
    // end to end and wrote the draft back three separate times, so a set could
    // half-apply; this takes about as long as the slowest single picture.
    const wantSet = Math.min(3, Math.max(0, Math.round(Number(body?.options) || 0)));
    const choose = typeof body?.choose === 'string' ? body.choose.trim() : '';
    // THE EDIT IMAGE PANEL (components/ImageEditPanel.tsx) — none of these
    // spends an image credit.
    //   retitle: "<words>"   re-render the cover from the kept clean photograph
    //                        with these words (lib/retitle.ts); "" takes the
    //                        title off and the clean photo becomes the hero.
    //   suggestTitles: true  three other short titles from the text model.
    //   saveNotes: "<notes>" keep the notes for the next take without making one.
    const retitle = typeof body?.retitle === 'string' ? body.retitle : body?.noTitle === true ? '' : null;
    const suggestTitles = body?.suggestTitles === true;
    const saveNotes = typeof body?.saveNotes === 'string' ? body.saveNotes.trim().slice(0, 600) : null;
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
    const direction = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 600)
      : typeof body?.direction === 'string' ? body.direction.trim().slice(0, 600) : '';
    // Notes given with THIS request replace the stored ones (an empty string
    // clears them); a request without any reuses what the last take was made
    // with, so "New image" and "Show me 3 options" keep the team's notes.
    const directionGiven = typeof body?.prompt === 'string' || typeof body?.direction === 'string';
    const useUrl = typeof body?.useUrl === 'string' ? body.useUrl.trim() : '';
    if (brandPhotoUrl && !/^https:\/\/\S+$/i.test(brandPhotoUrl)) {
      return NextResponse.json({ error: 'bad_image', message: 'That library photo address is not one a network can fetch.' }, { status: 400 });
    }
    const dataUrl = typeof body?.dataUrl === 'string' ? body.dataUrl : '';
    const givenAlt = typeof body?.alt === 'string' ? body.alt.trim().slice(0, 300) : '';
    // Which Drive file a library photo came from, for the picture's provenance.
    const libraryFileId = typeof body?.libraryFileId === 'string' && /^[A-Za-z0-9_-]{10,}$/.test(body.libraryFileId) ? body.libraryFileId : null;
    // A photograph a person chose counts as used too, so the automatic picker
    // does not hand the same one to the next post (lib/library-topic.ts).
    if (libraryFileId) void touchLibraryUse(libraryFileId);

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
    const options = Array.isArray((pack as { _imageOptions?: PackImage[] })._imageOptions)
      ? ((pack as { _imageOptions?: PackImage[] })._imageOptions as PackImage[])
      : [];

    const topic = String((d as { topic?: string }).topic || 'regenerative medicine');
    // The notes the next take will be made with (see `directionGiven`).
    const effectiveDirection = directionGiven ? direction : notesOf(existing);

    // PICK ONE. No generation: the chosen proposition simply becomes the hero.
    if (choose) {
      const found = [...options, ...(existing ? [existing] : [])].find((o) => o?.url === choose);
      if (!found) return NextResponse.json({ error: 'not_an_option', message: 'That image is not one of this draft\'s propositions.' }, { status: 400 });
      const { data: freshRow } = await sb.from('drafts').select('pack').eq('id', id).eq('user_id', user.id).maybeSingle();
      const currentPack = (freshRow as { pack?: Record<string, unknown> } | null)?.pack ?? pack;
      const prior = (currentPack as { _image?: PackImage })._image;
      // The draft's generation count stays with the draft, whichever take is up.
      const picked: PackImage = { ...found, takes: Math.max(takesOf(found), takesOf(prior)) };
      // The one being replaced joins the propositions, so nothing is lost.
      const keep = [...options, ...(prior && prior.url !== choose ? [prior] : [])]
        .filter((o, i, all) => o?.url && o.url !== choose && all.findIndex((x) => x.url === o.url) === i)
        .slice(-5);
      const { error: setErr } = await sb.from('drafts')
        .update({ pack: { ...currentPack, _image: picked, _imageOptions: keep } })
        .eq('id', id).eq('user_id', user.id);
      if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });
      return NextResponse.json({ image: picked, options: keep });
    }

    // OTHER WORDS FOR THE COVER: a text call, never an image one.
    if (suggestTitles) {
      // A text-model call: capped with the other title suggestions (/api/title).
      const rlTitle = await checkRateLimit(user.id, 'title');
      if (!rlTitle.ok) {
        return NextResponse.json(
          { error: 'rate_limited', limit: rlTitle.limit },
          { status: 429, headers: { 'Retry-After': String(rlTitle.retryAfterSec) } },
        );
      }
      const planner = plannerImageFor(pack);
      const current = existing?.titled ? existing.titled.title : coverTitleFor(pack, topic);
      const titles = await suggestCoverTitles({
        angle: planner?.subject || topic,
        pillarName: planner?.pillarName || null,
        copy: briefSource(pack),
        current,
        avoid: planner ? [planner.title] : [],
      });
      return NextResponse.json({ titles, current });
    }
    // Brand profile keeps the image on-brand (optional, fail-soft).
    const loadBrand = async (): Promise<BrandContext | undefined> => {
      try {
        const { data: bp } = await sb.from('brand_profiles').select('*').eq('user_id', user.id).maybeSingle();
        return bp ? (bp as BrandContext) : undefined;
      } catch (err) { /* optional */ reportError('drafts-image:brand-load', err); return undefined; }
    };
    /** Set `_image` on the draft as it is NOW (the read above is stale after any long step) and remove what it replaced. */
    const setHero = async (image: PackImage) => {
      const { data: freshRow } = await sb.from('drafts').select('pack').eq('id', id).eq('user_id', user.id).maybeSingle();
      const currentPack = (freshRow as { pack?: Record<string, unknown> } | null)?.pack ?? pack;
      const nextPack = { ...currentPack, _image: image };
      const { error: setErr } = await sb.from('drafts').update({ pack: nextPack }).eq('id', id).eq('user_id', user.id);
      if (setErr) throw new Error(setErr.message);
      await removeSuperseded(currentPack, nextPack);
    };
    // NEW WORDS ON THE SAME PICTURE (or none). The clean photograph behind the
    // cover is fetched back and re-rendered with lib/title-cover.ts — no image
    // model, no credits. A picture from before covers existed has no clean
    // photograph, and the panel's button already says so (lib/cover-edit.ts).
    if (retitle != null) {
      const decision = retitleDecision(existing);
      if (!decision.ok || !existing) return NextResponse.json({ error: 'cannot_retitle', message: decision.ok ? 'There is no picture on this draft yet.' : decision.reason }, { status: 400 });
      try {
        const made = await retitleImage(existing, cleanCoverTitle(retitle), topic);
        await setHero(made);
        return NextResponse.json({ image: made, retitled: true });
      } catch (e) {
        reportError('drafts-image:retitle', e, { id });
        return NextResponse.json({ error: 'retitle_failed', message: 'The title could not be set on this picture: ' + (e instanceof Error ? e.message : 'unknown error') }, { status: 502 });
      }
    }

    // KEEP THE NOTES for the next take, without making one.
    if (saveNotes != null) {
      if (!existing) return NextResponse.json({ error: 'no_image', message: 'Make a picture first; the notes are kept with it.' }, { status: 400 });
      const kept: PackImage = { ...existing };
      if (saveNotes) kept.direction = saveNotes; else delete kept.direction;
      try { await setHero(kept); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'draft update failed' }, { status: 500 }); }
      return NextResponse.json({ image: kept, saved: true });
    }

    // A LIBRARY PHOTO WITH THE BRAND FILTER AND THE TITLE. The photo itself
    // becomes the hero: measured and graded toward the house palette, checked
    // for a head under the title band (padded with sky when there is one),
    // titled like a planner cover. No image model, no credits.
    if (brandPhotoUrl) {
      try {
        const made = await libraryHero({ url: brandPhotoUrl, title: true, pack, topic, brand: await loadBrand(), libraryFileId, libraryName: givenAlt || null });
        await setHero(made.image);
        return NextResponse.json({ image: made.image, notes: made.notes, palette: made.decision.verdict });
      } catch (e) {
        reportError('drafts-image:library-hero', e, { id });
        return NextResponse.json(
          { error: 'library_photo_failed', message: 'That library photo could not be prepared: ' + (e instanceof Error ? e.message : 'unknown error') + '. Try another photo.' },
          { status: 502 },
        );
      }
    }

    // A stored image the checker marked as containing text is never good
    // enough to serve as "done": content images must be text-free, so treat
    // it like a regenerate request (next composition variant) instead.
    // A PHOTOGRAPH THE CLINIC CHOSE. Saved as the hero image as given — no
    // generation, no checks: the text rule exists because an image MODEL
    // writes gibberish signage, and a real photograph of the clinic is not
    // that. It is their picture; they have seen it. A library photo gets the
    // brand's colour filter on the way (lib/library-hero.ts) and no title;
    // when the filter cannot run, the photo goes in as it is, as before.
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
      let chosen: PackImage = {
        url,
        prompt: direction || '',
        alt: givenAlt || 'Photograph chosen by the clinic',
        model: source === 'upload' ? 'uploaded' : 'library',
        createdAt: new Date().toISOString(),
        variant: 0,
        source,
      };
      let notes: string[] = [];
      if (source === 'library') {
        try {
          const graded = await libraryHero({ url, title: false, pack, topic, brand: await loadBrand(), libraryFileId, libraryName: givenAlt || null });
          chosen = { ...graded.image, alt: chosen.alt, prompt: chosen.prompt };
          notes = graded.notes;
        } catch (e) {
          reportError('drafts-image:library-grade', e, { id });
          notes = ['the brand filter could not be applied, so the photo was used as it is'];
        }
      }
      try { await setHero(chosen); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'draft update failed' }, { status: 500 }); }
      return NextResponse.json({ image: chosen, notes });
    }

    // Text, or a banned prop: an image that may never ship is never reused.
    const existingHasText = imageUnshippable(existing?.verification);
    // A weekly-planner draft whose picture predates the title cover (the old
    // dark reception photos) is replaced once with the new consultation cover.
    // Chosen photos (library / upload) are the team's own choice and are kept.
    const plannerNeedsCover = Boolean(plannerImageFor(pack)) && Boolean(existing?.url) &&
      !(existing as { titled?: unknown } | undefined)?.titled &&
      !['library', 'upload'].includes(String(existing?.source || ''));
    // A direction is itself a request for a new image: somebody typed what they
    // want, and returning the cached one would answer a different question.
    // A SET is always a request for new pictures — the draft having a hero
    // already is the normal case, and returning it unchanged made the whole
    // feature a no-op.
    if (existing?.url && !regenerate && !asOption && !wantSet && !existingHasText && !direction && !plannerNeedsCover) {
      return NextResponse.json({ image: existing, cached: true });
    }
    const advanceVariant = regenerate || existingHasText || asOption || wantSet > 0;

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
    const brand = await loadBrand();

    const baseVariant = advanceVariant ? (existing?.variant ?? 0) + 1 + options.length : 0;
    const makeOne = (slot: number | null, variantOffset: number) => generatePackImage({
      topic,
      pack,
      brand,
      direction: effectiveDirection,
      // The title the team set (or turned off) stays on every new take.
      title: existing?.titled?.custom ? existing.titled.title : null,
      // Fresh generations start at variant 0; each regenerate (explicit, or
      // forced by a text-flagged stored image) advances to the next
      // composition (hero shot → macro lab → lifestyle → still-life → …).
      // Each proposition starts one composition further along, so a set of
      // three is three different shots rather than three near-duplicates.
      variant: baseVariant + variantOffset,
      // Which slot of the planner's picture plan this take is for.
      slot,
    });

    // A SET is generated in PARALLEL; one take failing does not take the
    // others down with it.
    const setResults = wantSet > 0
      ? await Promise.allSettled(Array.from({ length: wantSet }, (_, i) => makeOne(i + 1, i)))
      : [];
    const madeSet = setResults
      .filter((r): r is PromiseFulfilledResult<PackImage> => r.status === 'fulfilled')
      .map((r) => r.value);
    const setErrors = setResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    if (wantSet > 0 && !madeSet.length) {
      return NextResponse.json({ error: setErrors[0] || 'image generation failed' }, { status: 500 });
    }

    const image = wantSet > 0
      ? madeSet[0]
      : await makeOne(askedSlot ?? (asOption ? 1 + (options.length % 3) : (advanceVariant ? null : 0)), 0);

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

    // A proposition is kept ALONGSIDE the current hero (up to five), so the
    // reviewer can compare and choose; a plain reroll replaces as before.
    const priorImage = (currentPack as { _image?: PackImage })._image;
    // Propositions sit BESIDE the post's picture and never replace it. Asking
    // to see options used to swap the hero for the last take generated, which
    // is the opposite of what "click one to use it instead" promises — the
    // reviewer lost the very image they were comparing against.
    const proposing = wantSet > 0 || asOption;
    const madeNow = wantSet > 0 ? madeSet : [image];
    const nextOptions = proposing
      ? [...options, ...madeNow]
          .filter((o, i, all) => o?.url && all.findIndex((x) => x.url === o.url) === i)
          .slice(-5)
      : [];
    const nextHero = proposing ? (priorImage ?? image) : image;
    // The draft's generation count rides on whichever picture is the hero now.
    const takes = Math.max(takesOf(priorImage), takesOf(existing)) + madeNow.length;
    nextHero.takes = takes;
    // Owner update passes RLS via the session client.
    const nextPack = { ...currentPack, _image: nextHero, ...(nextOptions.length ? { _imageOptions: nextOptions } : { _imageOptions: [] }) };
    const { error } = await sb
      .from('drafts')
      .update({ pack: nextPack })
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // "New image" REPLACES. The object the draft just stopped pointing at goes
    // — after the write, so a failed write never orphans the image on screen.
    await removeSuperseded(currentPack, nextPack);

    return NextResponse.json({ image: nextHero, options: nextOptions, made: proposing ? madeNow.length : 1, failed: setErrors });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'image generation failed' },
      { status: 500 }
    );
  }
}

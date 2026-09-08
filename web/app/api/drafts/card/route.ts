// POST /api/drafts/card
// body: { id, size?: 'portrait'|'square'|'landscape', ground?: 'paper'|'pearl'|'rust'|'cocoa'|'seal'|'black'|'photo',
//         slides?: [{ kicker?, headline, body? }], setHero?: boolean, aviso?: boolean }
//
// Turns a draft into brand cards — the numbered educational slides the team's
// gallery is made of — painted by lib/brand-card.ts in the Brand Brain palette
// and marks. The words come from the pack (or from what the reviewer typed),
// never from an image model, so they are exact; a 'photo' cover uses the
// draft's existing verified, text-free hero image behind a paper panel.
// Cards are stored in the public image bucket and recorded on the draft as
// pack._cards; with setHero the first card also becomes pack._image so it is
// what goes to Metricool. Nothing here posts anything.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { supabaseServer } from '@/lib/supabase';
import { reportError } from '@/lib/report';
import { storeBytes, type PackImage } from '@/lib/images';
import { renderBrandCard, setStoredFontReader } from '@/lib/brand-card';
import { readStoredFonts } from '@/lib/brand-fonts';
import { normalizeVisual } from '@/lib/brand-visual';
import { avisoNumberFor } from '@/lib/compliance';
import {
  CARD_SIZES, groundForSlide, normalizeGround, normalizeSize, normalizeSlides, slidesFromPack, type CardGround,
} from '@/lib/brand-card-layout';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Licensed typefaces uploaded through Brand Brain live in private storage.
setStoredFontReader(readStoredFonts);

export type StoredCard = { url: string; index: number; headline: string; body?: string; kicker?: string; ground: CardGround; width: number; height: number };
export type PackCards = { createdAt: string; size: string; ground: CardGround; standIn: boolean; standInFaces: string[]; slides: StoredCard[] };

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'generate');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  const id = String(body?.id || '').trim();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const size = normalizeSize(body?.size);
  let ground = normalizeGround(body?.ground);
  const setHero = body?.setHero === true;
  const wantAviso = body?.aviso !== false;

  const sb = await supabaseServer();
  const { data: d, error: dErr } = await sb
    .from('drafts')
    .select('id, topic, pack, channels')
    .eq('id', id)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });
  if (!d) return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  const pack = ((d as { pack?: Record<string, unknown> }).pack || {}) as Record<string, unknown>;
  const topic = String((d as { topic?: string }).topic || 'Cellular Institute');

  // Brand Brain: palette for the paint, permit number for the footer.
  let visualRaw: unknown = null;
  let brandAviso: string | null = null;
  try {
    const { data: bp } = await sb.from('brand_profiles').select('*').eq('user_id', auth.userId).maybeSingle();
    visualRaw = (bp as { visual?: unknown } | null)?.visual ?? null;
    brandAviso = (bp as { aviso_publicidad?: string } | null)?.aviso_publicidad ?? null;
  } catch (e) { reportError('drafts-card:brand', e); }
  const visual = normalizeVisual(visualRaw);
  // Cards go to Instagram and Facebook far more often than not, so the permit
  // line is on by default; the caller can leave it off for a LinkedIn-only set.
  const aviso = wantAviso ? avisoNumberFor(brandAviso) : null;

  const typed = normalizeSlides(body?.slides);
  const slides = typed.length ? typed : slidesFromPack(topic, pack);
  if (!slides.length) return NextResponse.json({ error: 'nothing to put on a card', message: 'Give the draft some text first, or type a headline.' }, { status: 422 });

  // A photo cover needs the draft's verified hero image. Without one (or with
  // one the checker flagged for text) the cover falls back to the brand colour
  // rather than shipping an unverified picture under the words.
  let photo: { bytes: Buffer; contentType: string } | null = null;
  let note: string | null = null;
  if (ground === 'photo') {
    const hero = pack._image as PackImage | undefined;
    const usable = hero?.url && hero.verification?.textDetected !== true && hero.source !== 'brand-card';
    if (usable) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15_000);
        const r = await fetch(hero.url, { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) photo = { bytes: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'image/jpeg' };
      } catch (e) { reportError('drafts-card:photo', e); }
    }
    if (!photo) { ground = 'rust'; note = 'No verified hero image on this draft yet, so the cover uses the brand colour. Generate an image first for a photo cover.'; }
  }

  const stored: StoredCard[] = [];
  let standIn = false;
  let standInFaces: string[] = [];
  try {
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      const g = groundForSlide(ground, i + 1, slides.length);
      const out = await renderBrandCard({
        spec: { ...s, size, ground: g, index: i + 1, total: slides.length, aviso, standIn: false },
        visual,
        photo: g === 'photo' ? photo : null,
      });
      standIn = out.standIn;
      standInFaces = out.standInFaces;
      const url = await storeBytes(out.png, 'image/png', 'png', topic + '-card-' + (i + 1));
      stored.push({ url, index: i + 1, headline: s.headline, body: s.body, kicker: s.kicker, ground: g, width: out.width, height: out.height });
    }
  } catch (e) {
    reportError('drafts-card:render', e);
    return NextResponse.json({ error: 'render_failed', message: 'The card could not be drawn just now.' }, { status: 500 });
  }

  const cards: PackCards = { createdAt: new Date().toISOString(), size, ground, standIn, standInFaces, slides: stored };
  const { width, height } = CARD_SIZES[size];
  // Re-read before writing: generation took a while and someone may have
  // edited the pack meanwhile. Only _cards (and _image when asked) are ours.
  const { data: fresh } = await sb.from('drafts').select('pack').eq('id', id).eq('user_id', auth.userId).maybeSingle();
  const current = ((fresh as { pack?: Record<string, unknown> } | null)?.pack ?? pack) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current, _cards: cards };
  if (setHero && stored[0]) {
    const hero: PackImage = {
      url: stored[0].url,
      prompt: 'brand card · ' + stored[0].headline,
      alt: stored[0].headline + ' — brand card for Cellular Institute',
      model: 'brand-card',
      createdAt: cards.createdAt,
      variant: 0,
      source: 'brand-card',
      // The words on a card are set by this code from approved text, not
      // hallucinated by a model — the text rule guards against the latter.
      verification: { status: 'approved', score: 100, issues: [], advisory: ['brand card — typography set by the dashboard, not generated'], textDetected: false, brandFit: 100, model: null, checkedAt: cards.createdAt },
    };
    next._image = hero;
  }
  const { error } = await sb.from('drafts').update({ pack: next }).eq('id', id).eq('user_id', auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, cards, width, height, note, hero: setHero ? next._image : null });
}

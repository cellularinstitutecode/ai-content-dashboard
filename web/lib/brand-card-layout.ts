// web/lib/brand-card-layout.ts
// The decisions behind a brand card, as pure functions: which slides a pack
// becomes, what size type fits, which colour goes on which ground, what the
// footer says. lib/brand-card.tsx paints; this file decides — so the rules
// that make a card look like the team's gallery are unit-tested without
// rendering a pixel.
//
// The gallery these cards match (the team's "Filtradas" folder) is a set of
// numbered educational slides: one idea per card, a serif headline, a short
// sans body, the slide count, the brand's earth palette. The AI never renders
// the words — a text-free background is generated and verified as always, and
// the typography is set here, exactly, from text a person wrote or approved.

import { DEFAULT_VISUAL, PAPER, textColorOn, type BrandVisual } from './brand-visual.ts';

export type CardSize = 'portrait' | 'square' | 'landscape';
export const CARD_SIZES: Record<CardSize, { width: number; height: number; label: string }> = {
  portrait: { width: 1080, height: 1350, label: 'Instagram portrait 4:5' },
  square: { width: 1080, height: 1080, label: 'Square 1:1' },
  landscape: { width: 1200, height: 630, label: 'Link / LinkedIn 1.91:1' },
};

export type CardGround = 'paper' | 'pearl' | 'rust' | 'cocoa' | 'seal' | 'black' | 'photo';

export type SlideSpec = {
  /** Small label above the headline — a section name, a question, a number word. */
  kicker?: string;
  headline: string;
  body?: string;
};

export type CardSpec = SlideSpec & {
  size: CardSize;
  ground: CardGround;
  index: number;
  total: number;
  /** The clinic's advertising permit line, when the card is for Instagram/Facebook. */
  aviso?: string | null;
  /** Rendered with an open stand-in typeface (no licensed font files present). */
  standIn: boolean;
};

const MAX_HEADLINE = 110;
const MAX_BODY = 260;
const MAX_KICKER = 40;

export function clean(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A ground name → its hex, from the profile's palette by role when it has one. */
export function groundHex(ground: CardGround, visual: BrandVisual = DEFAULT_VISUAL): string {
  const byRole = (role: 'dark' | 'accent' | 'light', nth = 0) =>
    visual.palette.filter((c) => c.role === role)[nth]?.hex;
  switch (ground) {
    case 'paper': return PAPER;
    case 'pearl': return byRole('light') || '#E0D2B7';
    case 'rust': return byRole('accent') || '#9F4D27';
    case 'cocoa': return byRole('accent', 1) || byRole('accent') || '#C37338';
    case 'seal': return byRole('dark', 1) || byRole('dark') || '#65371F';
    case 'black': return byRole('dark') || '#282119';
    case 'photo': return PAPER; // the photograph is the ground; paper shows behind the caption panel
  }
}

/** Ink and accent for a ground: ink has the most contrast; the accent is the palette's accent unless it IS the ground. */
export function inkFor(ground: CardGround, visual: BrandVisual = DEFAULT_VISUAL): { ink: string; accent: string; muted: string } {
  const g = groundHex(ground, visual);
  const ink = textColorOn(g, visual.palette);
  const accents = visual.palette.filter((c) => c.role === 'accent').map((c) => c.hex);
  const accent = accents.find((a) => a.toUpperCase() !== g.toUpperCase()) || ink;
  return { ink, accent, muted: ink + 'B3' }; // ~70% alpha
}

/**
 * Headline size from its length, so a long line shrinks instead of wrapping
 * into a paragraph. Tuned for the 1080-wide canvas; scaled by the renderer.
 */
export function headlineSize(text: string, size: CardSize): number {
  const n = text.length;
  const base = n <= 24 ? 104 : n <= 40 ? 88 : n <= 60 ? 74 : n <= 85 ? 62 : 52;
  return size === 'landscape' ? Math.round(base * 0.72) : base;
}

export function footerText(index: number, total: number): string {
  return total > 1 ? `${index}/${total}` : '';
}

/**
 * Turn a content pack into slides the way the gallery does it: the topic is
 * the cover, then one card per paragraph of the caption (hashtags, the REF
 * line and the AVISO line are not slide copy — they belong in the post text).
 * Capped at 8, the carousel limit the team already uses.
 */
export function slidesFromPack(topic: string, pack: Record<string, unknown> | null | undefined, max = 8): SlideSpec[] {
  const text = String(pack?.instagram || pack?.facebook || pack?.linkedin || pack?.blog || '');
  const paras = text
    .split(/\n{2,}|\n(?=[A-ZÁÉÍÓÚÑ0-9])/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p && !/^REF:/i.test(p) && !/AVISO DE PUBLICIDAD/i.test(p) && !/^(#\S+\s*)+$/.test(p))
    .map((p) => p.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const slides: SlideSpec[] = [{ kicker: 'Cellular Institute', headline: clean(topic, MAX_HEADLINE) }];
  for (const p of paras) {
    if (slides.length >= max) break;
    // A short paragraph is a headline on its own; a long one splits at the first sentence.
    const m = /^(.{12,110}?[.!?])\s+(.+)$/.exec(p);
    if (p.length <= MAX_HEADLINE) slides.push({ headline: p });
    else if (m) slides.push({ headline: clean(m[1].replace(/[.]$/, ''), MAX_HEADLINE), body: clean(m[2], MAX_BODY) });
    else slides.push({ headline: clean(p.slice(0, MAX_HEADLINE).replace(/\s\S*$/, ''), MAX_HEADLINE), body: clean(p.slice(MAX_HEADLINE), MAX_BODY) });
  }
  return slides;
}

/** Validate what a person typed or the pack produced into render-ready specs. */
export function normalizeSlides(raw: unknown, max = 8): SlideSpec[] {
  const out: SlideSpec[] = [];
  if (!Array.isArray(raw)) return out;
  for (const r of raw.slice(0, max)) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const headline = clean(o.headline, MAX_HEADLINE);
    if (!headline) continue;
    const s: SlideSpec = { headline };
    const kicker = clean(o.kicker, MAX_KICKER); if (kicker) s.kicker = kicker;
    const body = clean(o.body, MAX_BODY); if (body) s.body = body;
    out.push(s);
  }
  return out;
}

const GROUNDS: CardGround[] = ['paper', 'pearl', 'rust', 'cocoa', 'seal', 'black', 'photo'];
export function normalizeGround(v: unknown): CardGround {
  return GROUNDS.includes(v as CardGround) ? (v as CardGround) : 'paper';
}
export function normalizeSize(v: unknown): CardSize {
  return v === 'square' || v === 'landscape' ? v : 'portrait';
}

/**
 * The ground sequence for a carousel: the cover on the strongest colour, the
 * body slides alternating paper and pearl so the set reads as one system — the
 * rhythm the gallery's numbered series use.
 */
export function groundForSlide(requested: CardGround, index: number, total: number): CardGround {
  if (requested === 'photo') return index === 1 ? 'photo' : 'paper';
  if (total === 1) return requested;
  if (index === 1) return requested === 'paper' || requested === 'pearl' ? 'rust' : requested;
  return index % 2 === 0 ? 'paper' : 'pearl';
}

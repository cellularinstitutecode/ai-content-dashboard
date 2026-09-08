// web/lib/brand-visual.ts
// The brand's VISUAL identity — palette, materials, light, photography
// direction — as data the image pipeline can read, instead of a PDF only
// people can. Brand Brain stores one of these per profile (brand_profiles.visual);
// buildImagePrompt() turns it into prompt language, the vision reviewer scores
// against it, and the brand-card compositor paints with it.
//
// Pure: no I/O, so every rule here is unit-tested. The defaults are the
// Cellular Institute guide (Brand by Genesis, 2026) — the clinic gets its own
// look even before anyone opens Brand Brain, and a blank field falls back to
// the guide rather than to "generic clinic".

export type BrandColor = { name: string; hex: string; role: 'dark' | 'accent' | 'light' };

export type BrandVisual = {
  /** Primary palette, darkest first. Roles decide text/background pairing on cards. */
  palette: BrandColor[];
  /** The materials and light a photograph should show — the brand's world. */
  materials: string;
  /** How the camera behaves: framing, angle, styling, expression. */
  photography: string;
  /** Things the brand's pictures never show, beyond the pipeline's own safety rules. */
  never: string[];
  /** Typeface names, for the card compositor's font lookup and for the record. */
  fonts: { headline: string; body: string };
};

const HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULT_VISUAL: BrandVisual = {
  palette: [
    { name: 'Eerie Black', hex: '#282119', role: 'dark' },
    { name: 'Seal Brown', hex: '#65371F', role: 'dark' },
    { name: 'Rust', hex: '#9F4D27', role: 'accent' },
    { name: 'Cocoa Brown', hex: '#C37338', role: 'accent' },
    { name: 'Pearl', hex: '#E0D2B7', role: 'light' },
  ],
  materials:
    'warm cream and off-white walls, pale travertine and veined marble, walnut wood panelling, terracotta and rust accents, ' +
    'warm recessed light, matte finishes; staff in black scrubs; no cool blue or clinical white-and-steel palette',
  photography:
    'clean compositions with generous negative space; eye-level or slightly elevated camera; minimal styling; natural, ' +
    'unposed expressions; calm, confident, premium; the picture shows how the clinic thinks and cares, not what it sells',
  never: [
    'stock-photo cheerfulness or forced smiles at the camera',
    'cool blue clinical lighting, chrome and glass laboratory clichés',
    'crowded frames, props, or decorative clutter',
  ],
  fonts: { headline: 'Canela', body: 'Nexa' },
};

/** Off-white paper the guide sets everything on — the card ground when no palette colour is asked for. */
export const PAPER = '#F5F1EA';

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Accept whatever Brand Brain saved (or a hand-edited JSON blob) and return a
 * complete, safe visual: bad colours dropped, blanks filled from the guide,
 * lengths capped so a profile can never blow up a prompt.
 */
export function normalizeVisual(raw: unknown): BrandVisual {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const palette: BrandColor[] = [];
  if (Array.isArray(o.palette)) {
    for (const c of o.palette.slice(0, 8)) {
      const cc = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      const hex = str(cc.hex, 7).toUpperCase();
      if (!HEX.test(hex)) continue;
      const role = cc.role === 'dark' || cc.role === 'accent' || cc.role === 'light' ? cc.role : roleOf(hex);
      palette.push({ name: str(cc.name, 40) || hex, hex, role });
    }
  }
  const never = Array.isArray(o.never) ? o.never.map((n) => str(n, 120)).filter(Boolean).slice(0, 8) : [];
  const fonts = (o.fonts && typeof o.fonts === 'object' ? o.fonts : {}) as Record<string, unknown>;
  return {
    palette: palette.length >= 2 ? palette : DEFAULT_VISUAL.palette,
    materials: str(o.materials, 400) || DEFAULT_VISUAL.materials,
    photography: str(o.photography, 400) || DEFAULT_VISUAL.photography,
    never: never.length ? never : DEFAULT_VISUAL.never,
    fonts: {
      headline: str(fonts.headline, 40) || DEFAULT_VISUAL.fonts.headline,
      body: str(fonts.body, 40) || DEFAULT_VISUAL.fonts.body,
    },
  };
}

/** Relative luminance (sRGB), 0 = black, 1 = white. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A colour's role from its lightness when the profile did not say. */
export function roleOf(hex: string): BrandColor['role'] {
  const l = luminance(hex);
  return l > 0.5 ? 'light' : l < 0.08 ? 'dark' : 'accent';
}

/** WCAG contrast ratio between two colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The palette colour to write with on a given ground: the lightest colour on a
 * dark ground, the darkest on a light one — always the pairing with the most
 * contrast, so a card is legible whatever colour it is asked for. The guide's
 * own logo-usage page pairs exactly this way (Pearl on Rust, Seal Brown on Pearl).
 */
export function textColorOn(ground: string, palette: BrandColor[] = DEFAULT_VISUAL.palette): string {
  let best = palette[0]?.hex || '#282119';
  let bestC = 0;
  for (const c of palette) {
    const cr = contrast(ground, c.hex);
    if (cr > bestC) { bestC = cr; best = c.hex; }
  }
  // The palette pairs itself the way the guide does (Pearl on Rust is 3.9:1 —
  // fine for display type). Paper and white are outside the palette and only
  // step in when no palette colour reads at all on this ground.
  if (bestC < 3) {
    for (const extra of [PAPER, '#FFFFFF']) {
      if (contrast(ground, extra) > bestC) { best = extra; bestC = contrast(ground, extra); }
    }
  }
  return best;
}

/**
 * The visual identity as prompt language for the image model. Colours are
 * named AND given as hex — models follow "terracotta and cream" better than
 * numbers, but the numbers pin what "terracotta" means for this brand.
 */
export function visualPromptBlock(v: BrandVisual): string {
  const colours = v.palette.map((c) => `${c.name.toLowerCase()} (${c.hex})`).join(', ');
  return [
    `Colour world: ${colours} — warm, earthy, low-saturation; let these tones dominate the frame.`,
    `Materials and light: ${v.materials}.`,
    `Photography: ${v.photography}.`,
    v.never.length ? `Never: ${v.never.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * What the vision reviewer scores brand fit against — advisory, never a reason
 * to flag. A picture can be perfectly safe and still look like someone else's
 * clinic; that is a note for the human, not a defect.
 */
export function brandFitRubric(v: BrandVisual): string {
  const colours = v.palette.map((c) => c.name).join(', ');
  return (
    `BRAND FIT (advisory, 0-100): does the image live in this brand's world? Palette: ${colours} — warm earth tones, ` +
    `not cool blues or steel. Materials/light: ${v.materials}. Photography: ${v.photography}. ` +
    `Score 90+ only when palette, materials and camera all match; 50 when neutral; under 30 when it reads as a different brand.`
  );
}

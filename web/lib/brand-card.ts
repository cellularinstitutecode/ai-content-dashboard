// web/lib/brand-card.ts
// Paints a brand card: the typographic educational slide the team's gallery is
// made of, set in the brand's palette and marks, with the words placed by
// this code — never by an image model. The AI's part is the optional,
// text-free, verified photograph behind a cover card. Everything else here is
// deterministic, so a card can be re-rendered pixel-for-pixel.
//
// Rendered with next/og (satori → PNG), which ships with Next — no new
// dependency. Written with createElement rather than JSX so the renderer can
// be exercised by plain `node --test` (type-stripping does not transform JSX).
//
// Fonts: the licensed brand files in public/fonts/brand/ are used when present
// (Canela for headlines; Nexa or Rische for body). Without them an open
// stand-in is used and the card says so in its corner, so nobody mistakes a
// stand-in for final type.

import { createElement as h, type ReactElement } from 'react';
import { ImageResponse } from 'next/og.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WORDMARK, BRANDMARK, markHeight, type BrandMark } from './brand-marks.ts';
import { CARD_SIZES, groundHex, inkFor, headlineSize, footerText, type CardSpec } from './brand-card-layout.ts';
import { DEFAULT_VISUAL, type BrandVisual } from './brand-visual.ts';
import { describeFontFile, isTrialFont, type FontRole } from './brand-font-rules.ts';

type Font = { name: string; data: ArrayBuffer; weight?: 300 | 400 | 500 | 600 | 700; style?: 'normal' | 'italic' };
export type FontSet = {
  fonts: Font[];
  headlineFamily: string;
  bodyFamily: string;
  /** True when any role runs on an open stand-in. */
  standIn: boolean;
  /** Which roles run on a stand-in — 'headline' until Canela is licensed, 'body' until Nexa or Rische is. */
  standInFaces: FontRole[];
  /** File names the licensed faces were loaded from. */
  sources: string[];
};

const BRAND_DIR = () => path.join(process.cwd(), 'public', 'fonts', 'brand');
const STANDIN_DIR = () => path.join(process.cwd(), 'public', 'fonts', 'standin');
// Licensed files come from two places: the gitignored local folder (development)
// and the private storage bucket Brand Brain uploads into (production). The
// bucket read is injected so this module stays testable without Supabase.
type StoredFontReader = () => Promise<{ name: string; data: ArrayBuffer }[]>;
let storedFontReader: StoredFontReader | null = null;
export function setStoredFontReader(reader: StoredFontReader | null): void { storedFontReader = reader; fontCache = null; }
const FONT_CACHE_MS = 60_000;
let fontCacheAt = 0;

async function readFont(file: string): Promise<ArrayBuffer | null> {
  try {
    const b = await fs.readFile(file);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  } catch {
    return null;
  }
}

let fontCache: Promise<FontSet> | null = null;

/**
 * The brand's own type when the files are there, the stand-in when not.
 * Matching is by file name (lib/brand-font-rules.ts): "canela" is the headline
 * face; "nexa" or "rische" the body face; weight and style from the name.
 * Trial/demo builds are ignored even if someone put them on disk. Cached for
 * a minute so an upload shows up without a redeploy.
 */
export function loadFonts(): Promise<FontSet> {
  if (!fontCache || Date.now() - fontCacheAt > FONT_CACHE_MS) { fontCache = loadFontsUncached(); fontCacheAt = Date.now(); }
  return fontCache;
}

async function loadFontsUncached(): Promise<FontSet> {
  const candidates: { name: string; data: ArrayBuffer }[] = [];
  let files: string[] = [];
  try { files = await fs.readdir(BRAND_DIR()); } catch { files = []; }
  for (const f of files) {
    const data = await readFont(path.join(BRAND_DIR(), f));
    if (data) candidates.push({ name: f, data });
  }
  if (storedFontReader) {
    try { candidates.push(...(await storedFontReader())); } catch { /* the local files and stand-ins still work */ }
  }
  const fonts: Font[] = [];
  const sources: string[] = [];
  let headlineFamily = '';
  let nexa = false;
  let rische = false;
  for (const c of candidates) {
    const d = describeFontFile(c.name);
    if (!d || isTrialFont(c.name)) continue;
    fonts.push({ name: d.family, data: c.data, weight: d.weight, style: d.style });
    sources.push(c.name);
    if (d.family === 'Canela') headlineFamily = 'Canela';
    if (d.family === 'Nexa') nexa = true;
    if (d.family === 'Rische') rische = true;
  }
  let bodyFamily = nexa ? 'Nexa' : rische ? 'Rische' : '';
  const standInFaces: FontRole[] = [];
  if (!headlineFamily) {
    standInFaces.push('headline');
    const data = await readFont(path.join(STANDIN_DIR(), 'InstrumentSerif-Regular.ttf'));
    if (data) fonts.push({ name: 'Instrument Serif', data, weight: 400, style: 'normal' });
    headlineFamily = 'Instrument Serif';
  }
  if (!bodyFamily) {
    standInFaces.push('body');
    const reg = await readFont(path.join(STANDIN_DIR(), 'Outfit-Regular.ttf'));
    const bold = await readFont(path.join(STANDIN_DIR(), 'Outfit-Bold.ttf'));
    if (reg) fonts.push({ name: 'Outfit', data: reg, weight: 400, style: 'normal' });
    if (bold) fonts.push({ name: 'Outfit', data: bold, weight: 700, style: 'normal' });
    bodyFamily = 'Outfit';
  }
  return { fonts, headlineFamily, bodyFamily, standIn: standInFaces.length > 0, standInFaces, sources };
}

/** Drop the cache (tests, or after fonts are uploaded). */
export function resetFontCache(): void { fontCache = null; fontCacheAt = 0; }

/** The corner note a card carries while a face is still a stand-in. */
export function standInNote(faces: FontRole[]): string {
  if (!faces.length) return '';
  const missing = faces.map((f) => (f === 'headline' ? 'Canela' : 'Nexa / Rische'));
  return 'stand-in ' + faces.join(' + ') + ' type · add ' + missing.join(' and ') + ' in Brand Brain';
}

// satori supports inline SVG; a mark is a viewBox plus filled paths.
function mark(m: BrandMark, color: string, width: number, opacity = 1): ReactElement {
  return h(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: m.viewBox, width, height: markHeight(m, width), style: { opacity } },
    ...m.paths.map((d, i) => h('path', { key: i, d, fill: color, fillRule: 'evenodd' })),
  );
}

export type RenderInput = {
  spec: CardSpec;
  visual?: BrandVisual;
  /** JPEG/PNG bytes for a 'photo' ground — the AI's verified, text-free photograph. */
  photo?: { bytes: Buffer; contentType: string } | null;
};

/** The React tree for one card — exported so its structure can be asserted without rendering. */
export function cardElement(input: RenderInput, fontSet: FontSet): ReactElement {
  const { spec } = input;
  const visual = input.visual || DEFAULT_VISUAL;
  const { width, height } = CARD_SIZES[spec.size];
  const isPhoto = spec.ground === 'photo' && input.photo;
  const groundColor = isPhoto ? groundHex('paper', visual) : groundHex(spec.ground, visual);
  const { ink, accent, muted } = inkFor(isPhoto ? 'paper' : spec.ground, visual);
  const pad = Math.round(width * 0.067); // 72 on a 1080 canvas
  const hSize = headlineSize(spec.headline, spec.size);
  const bodySize = spec.size === 'landscape' ? 24 : 30;
  const serif = fontSet.headlineFamily;
  const sans = fontSet.bodyFamily;
  const photoUrl = isPhoto && input.photo ? `data:${input.photo.contentType};base64,${input.photo.bytes.toString('base64')}` : null;
  // On a photo cover the picture takes the top and a paper panel holds the words.
  const panelTop = isPhoto ? Math.round(height * 0.54) : 0;

  const children: ReactElement[] = [];
  if (photoUrl) {
    children.push(
      h('img', { key: 'photo', src: photoUrl, width, height: panelTop + 40, style: { position: 'absolute', top: 0, left: 0, width, height: panelTop + 40, objectFit: 'cover' } }),
    );
  } else {
    // The stationery's watermark: a large, faint brandmark bleeding off the corner.
    children.push(
      h('div', { key: 'wm', style: { position: 'absolute', right: -width * 0.12, bottom: -height * 0.06, display: 'flex' } }, mark(BRANDMARK, ink, Math.round(width * 0.62), 0.07)),
    );
  }
  // Top row: brandmark + kicker.
  children.push(
    h(
      'div',
      { key: 'top', style: { position: 'absolute', top: pad, left: pad, right: pad, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      mark(BRANDMARK, isPhoto ? groundHex('pearl', visual) : accent, 84),
      spec.kicker
        ? h('div', { style: { fontFamily: sans, fontSize: 20, letterSpacing: 4, textTransform: 'uppercase', color: isPhoto ? groundHex('pearl', visual) : muted, fontWeight: 700 } }, spec.kicker.toUpperCase())
        : h('div', {}),
    ),
  );
  // Words.
  const words: ReactElement[] = [
    h('div', { key: 'h', style: { fontFamily: serif, fontSize: hSize, lineHeight: 1.04, color: ink, letterSpacing: -hSize * 0.015, display: 'flex' } }, spec.headline),
  ];
  if (spec.body) {
    words.push(h('div', { key: 'rule', style: { width: 72, height: 4, background: accent, marginTop: 28, marginBottom: 26, display: 'flex' } }));
    words.push(h('div', { key: 'b', style: { fontFamily: sans, fontSize: bodySize, lineHeight: 1.4, color: ink, display: 'flex', maxWidth: width - pad * 2 } }, spec.body));
  }
  children.push(
    h(
      'div',
      { key: 'words', style: { position: 'absolute', left: pad, right: pad, top: isPhoto ? panelTop + pad * 0.7 : pad + 150, bottom: pad + 120, display: 'flex', flexDirection: 'column', justifyContent: isPhoto ? 'flex-start' : 'center' } },
      ...words,
    ),
  );
  // Bottom row: wordmark, slide count, permit line, stand-in note.
  const footer = footerText(spec.index, spec.total);
  const bottomBits: ReactElement[] = [
    h('div', { key: 'wmk', style: { display: 'flex' } }, mark(WORDMARK, ink, Math.round(width * 0.26))),
    h('div', { key: 'n', style: { fontFamily: serif, fontSize: 40, color: accent, display: 'flex' } }, footer),
  ];
  children.push(
    h('div', { key: 'bottom', style: { position: 'absolute', left: pad, right: pad, bottom: pad, display: 'flex', flexDirection: 'column', gap: 14 } },
      h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' } }, ...bottomBits),
      spec.aviso
        ? h('div', { style: { fontFamily: sans, fontSize: 16, letterSpacing: 1, color: muted, display: 'flex' } }, 'AVISO DE PUBLICIDAD: ' + spec.aviso)
        : h('div', {}),
      spec.standIn
        ? h('div', { style: { fontFamily: sans, fontSize: 12, color: muted, display: 'flex', opacity: 0.8 } }, standInNote(fontSet.standInFaces))
        : h('div', {}),
    ),
  );

  return h(
    'div',
    { style: { width, height, background: groundColor, position: 'relative', display: 'flex', overflow: 'hidden' } },
    ...(isPhoto
      ? [h('div', { key: 'panel', style: { position: 'absolute', top: panelTop, left: 0, width, height: height - panelTop, background: groundColor, display: 'flex' } })]
      : []),
    ...children,
  );
}

/** Render one card to PNG bytes. */
export async function renderBrandCard(input: RenderInput): Promise<{ png: Buffer; width: number; height: number; standIn: boolean; standInFaces: FontRole[] }> {
  const fontSet = await loadFonts();
  const spec = { ...input.spec, standIn: fontSet.standIn };
  const { width, height } = CARD_SIZES[spec.size];
  const res = new ImageResponse(cardElement({ ...input, spec }, fontSet), { width, height, fonts: fontSet.fonts });
  const png = Buffer.from(await res.arrayBuffer());
  return { png, width, height, standIn: fontSet.standIn, standInFaces: fontSet.standInFaces };
}

/** PNG header → dimensions, for callers (and tests) that want to check what came out. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

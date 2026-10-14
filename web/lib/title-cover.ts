// web/lib/title-cover.ts
// Sets a post's title on its photograph the way the clinic's own feed does:
// a short sentence in large serif type, left-aligned in the quiet side of
// the picture beside the subject, the words that carry it in rust italic,
// the rest in dark brown, a short rule beneath (lib/title-cover-layout.ts).
//
// The words are painted here, never by the image model, so they are exact.
// Rendered with next/og (satori → PNG) like lib/brand-card.ts, whose font
// loader is reused: Canela when the licensed files have been uploaded in Brand
// Brain, the open Instrument Serif stand-in until then (a light, high-contrast
// serif close to the feed's). Unlike a brand card, the cover carries no
// stand-in note — Instrument Serif is an open font and fine to publish.
//
// Written with createElement rather than JSX so `node --test` can render it.

import { createElement as h, type ReactElement } from 'react';
import { ImageResponse } from 'next/og.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadFonts, type FontSet } from './brand-card.ts';
import { COVER, TITLE_ACCENT, TITLE_INK, TITLE_WASH_RGB, layoutTitle, type LayoutHints } from './title-cover-layout.ts';

export { plainTitle } from './title-cover-layout.ts';

type Font = FontSet['fonts'][number];

let italicCache: Promise<Font | null> | null = null;
/** The stand-in's italic, for the accented words. Canela's italic comes with its own upload when present. */
function standInItalic(): Promise<Font | null> {
  if (!italicCache) {
    italicCache = fs
      .readFile(path.join(process.cwd(), 'public', 'fonts', 'standin', 'InstrumentSerif-Italic.ttf'))
      .then((b) => ({ name: 'Instrument Serif', data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, weight: 400 as const, style: 'italic' as const }))
      .catch(() => null);
  }
  return italicCache;
}

/** The React tree for one cover — exported so its words and placement can be asserted without rendering. */
export function coverElement(input: { title: string; photoDataUrl: string; family: string; italic: boolean } & LayoutHints): ReactElement {
  const L = layoutTitle(input.title, { headTopPct: input.headTopPct, clearSide: input.clearSide });
  const lineEls = L.lines.map((line, li) =>
    h(
      'div',
      { key: 'l' + li, style: { display: 'flex', justifyContent: 'flex-start', flexWrap: 'nowrap' } },
      ...line.map((word, wi) =>
        h('div', {
          key: 'w' + wi,
          style: {
            display: 'flex',
            fontFamily: input.family,
            fontStyle: word.italic && input.italic ? 'italic' : 'normal',
            fontSize: L.size,
            lineHeight: 1.06,
            letterSpacing: -L.size * 0.006,
            color: word.accent ? TITLE_ACCENT : TITLE_INK,
            marginRight: wi < line.length - 1 ? Math.round(L.size * 0.26) : 0,
          },
        }, word.text),
      ),
    ),
  );
  // A soft cream wash behind the block, fading towards the subject AND
  // above and below, so the words read on any wall the photograph gives us
  // without a band across it. The renderer has no 2-D gradients or masks, so
  // the wash is a row of narrow columns, each fading top and bottom, their
  // strength falling off towards the subject.
  const washW = L.width + 300;
  const washTop = Math.max(0, L.y - 110);
  const washH = L.height + 220;
  const COLS = 14;
  const colW = Math.ceil(washW / COLS);
  const columns = Array.from({ length: COLS }, (_, i) => {
    const t = i / (COLS - 1); // 0 at the words' edge, 1 towards the subject
    const a = 0.82 * (1 - t) * (1 - t);
    const left = L.side === 'left' ? i * colW : COVER.width - (i + 1) * colW;
    return h('div', {
      key: 'c' + i,
      style: {
        position: 'absolute', left, top: washTop, width: colW + 1, height: washH, display: 'flex',
        backgroundImage: `linear-gradient(180deg, rgba(${TITLE_WASH_RGB},0) 0%, rgba(${TITLE_WASH_RGB},${a.toFixed(3)}) 22%, rgba(${TITLE_WASH_RGB},${a.toFixed(3)}) 78%, rgba(${TITLE_WASH_RGB},0) 100%)`,
      },
    });
  });
  return h(
    'div',
    { style: { width: COVER.width, height: COVER.height, position: 'relative', display: 'flex', background: '#F4EEE6', overflow: 'hidden' } },
    h('img', { key: 'photo', src: input.photoDataUrl, width: COVER.width, height: COVER.height, style: { position: 'absolute', top: 0, left: 0, width: COVER.width, height: COVER.height, objectFit: 'cover', objectPosition: 'center top' } }),
    ...columns,
    h(
      'div',
      { key: 'title', style: { position: 'absolute', top: L.y, left: L.x, width: L.width, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' } },
      ...lineEls,
      h('div', { key: 'rule', style: { display: 'flex', width: L.rule.width, height: 3, marginTop: L.rule.gap, background: TITLE_ACCENT, opacity: 0.7 } }),
    ),
  );
}

/** Paint the title on the photograph. Returns a 1080×1350 PNG (Instagram's 4:5). */
export async function renderTitleCover(input: { title: string; photo: { bytes: Buffer; contentType: string } } & LayoutHints): Promise<{ png: Buffer; width: number; height: number; family: string }> {
  const fontSet = await loadFonts();
  const fonts: Font[] = [...fontSet.fonts];
  const family = fontSet.headlineFamily;
  let italic = fonts.some((f) => f.name === family && f.style === 'italic');
  if (!italic && family === 'Instrument Serif') {
    const it = await standInItalic();
    if (it) { fonts.push(it); italic = true; }
  }
  const photoDataUrl = `data:${input.photo.contentType};base64,${input.photo.bytes.toString('base64')}`;
  const res = new ImageResponse(coverElement({ title: input.title, photoDataUrl, family, italic, headTopPct: input.headTopPct, clearSide: input.clearSide }), { width: COVER.width, height: COVER.height, fonts });
  const png = Buffer.from(await res.arrayBuffer());
  return { png, width: COVER.width, height: COVER.height, family };
}

// web/lib/title-cover.ts
// Sets a weekly-planner post's title on its photograph — the reference look:
// a bright consultation photo, one elegant serif title centred at the top, a
// hairline beneath, nothing else written on it.
//
// The words are painted here, never by the image model, so they are exact.
// Rendered with next/og (satori → PNG) like lib/brand-card.ts, whose font
// loader is reused: Canela when the licensed files have been uploaded in Brand
// Brain, the open Instrument Serif stand-in until then (a light, high-contrast
// serif close to the reference). Unlike a brand card, the cover carries no
// stand-in note — Instrument Serif is an open font and fine to publish.
//
// Written with createElement rather than JSX so `node --test` can render it.

import { createElement as h, type ReactElement } from 'react';
import { ImageResponse } from 'next/og.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadFonts, type FontSet } from './brand-card.ts';
import { COVER, TITLE_INK, TITLE_WASH, isConnector, splitTitleLines, titleFontSize } from './title-cover-layout.ts';

type Font = FontSet['fonts'][number];

let italicCache: Promise<Font | null> | null = null;
/** The stand-in's italic, for the connector words. Canela's italic comes with its own upload when present. */
function standInItalic(): Promise<Font | null> {
  if (!italicCache) {
    italicCache = fs
      .readFile(path.join(process.cwd(), 'public', 'fonts', 'standin', 'InstrumentSerif-Italic.ttf'))
      .then((b) => ({ name: 'Instrument Serif', data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, weight: 400 as const, style: 'italic' as const }))
      .catch(() => null);
  }
  return italicCache;
}

/** The React tree for one cover — exported so its words can be asserted without rendering. */
export function coverElement(input: { title: string; photoDataUrl: string; family: string; italic: boolean }): ReactElement {
  const lines = splitTitleLines(input.title);
  const size = titleFontSize(lines);
  let wordIndex = 0;
  const lineEls = lines.map((line, li) =>
    h(
      'div',
      { key: 'l' + li, style: { display: 'flex', justifyContent: 'center', flexWrap: 'nowrap' } },
      ...line.split(' ').map((word, wi, arr) => {
        const italic = input.italic && isConnector(word, wordIndex++);
        return h('div', {
          key: 'w' + wi,
          style: {
            display: 'flex',
            fontFamily: input.family,
            fontStyle: italic ? 'italic' : 'normal',
            fontSize: size,
            lineHeight: 1.08,
            letterSpacing: -size * 0.004,
            color: TITLE_INK,
            marginRight: wi < arr.length - 1 ? Math.round(size * 0.24) : 0,
          },
        }, word);
      }),
    ),
  );
  return h(
    'div',
    { style: { width: COVER.width, height: COVER.height, position: 'relative', display: 'flex', background: '#F4EEE6', overflow: 'hidden' } },
    h('img', { key: 'photo', src: input.photoDataUrl, width: COVER.width, height: COVER.height, style: { position: 'absolute', top: 0, left: 0, width: COVER.width, height: COVER.height, objectFit: 'cover', objectPosition: 'center 25%' } }),
    h('div', { key: 'wash', style: { position: 'absolute', top: 0, left: 0, width: COVER.width, height: Math.round(COVER.height * 0.5), backgroundImage: TITLE_WASH, display: 'flex' } }),
    h(
      'div',
      { key: 'title', style: { position: 'absolute', top: 96, left: 80, right: 80, display: 'flex', flexDirection: 'column', alignItems: 'center' } },
      ...lineEls,
      h('div', { key: 'rule', style: { display: 'flex', width: 120, height: 2, marginTop: 34, background: TITLE_INK, opacity: 0.4 } }),
    ),
  );
}

/** Paint the title on the photograph. Returns a 1080×1350 PNG (Instagram's 4:5). */
export async function renderTitleCover(input: { title: string; photo: { bytes: Buffer; contentType: string } }): Promise<{ png: Buffer; width: number; height: number; family: string }> {
  const fontSet = await loadFonts();
  const fonts: Font[] = [...fontSet.fonts];
  const family = fontSet.headlineFamily;
  let italic = fonts.some((f) => f.name === family && f.style === 'italic');
  if (!italic && family === 'Instrument Serif') {
    const it = await standInItalic();
    if (it) { fonts.push(it); italic = true; }
  }
  const photoDataUrl = `data:${input.photo.contentType};base64,${input.photo.bytes.toString('base64')}`;
  const res = new ImageResponse(coverElement({ title: input.title, photoDataUrl, family, italic }), { width: COVER.width, height: COVER.height, fonts });
  const png = Buffer.from(await res.arrayBuffer());
  return { png, width: COVER.width, height: COVER.height, family };
}

// web/lib/title-cover.ts
// Sets a post's title on its photograph the way the clinic's own feed does:
// a short sentence in large serif type, centred in the clear band of the
// picture — above the people when there is room, else at the bottom on a
// soft darkening — the words that carry it in rust italic, a short rule
// beneath (lib/title-cover-layout.ts). No wash behind the words: the clinic
// called the cream columns the earlier covers carried a white hue, and they
// are gone.
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
import { COVER, TITLE_ACCENT, TITLE_ACCENT_ON_DARK, TITLE_CREAM, TITLE_INK, layoutTitle, type LayoutHints } from './title-cover-layout.ts';

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
  const L = layoutTitle(input.title, { headTopPct: input.headTopPct, clearSide: input.clearSide, quiet: input.quiet, quietSide: input.quietSide });
  const justify = L.align === 'center' ? 'center' : L.align === 'right' ? 'flex-end' : 'flex-start';
  const ink = L.tone === 'cream' ? TITLE_CREAM : TITLE_INK;
  const accent = L.tone === 'cream' ? TITLE_ACCENT_ON_DARK : TITLE_ACCENT;
  const lineEls = L.lines.map((line, li) =>
    h(
      'div',
      { key: 'l' + li, style: { display: 'flex', justifyContent: justify, flexWrap: 'nowrap' } },
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
            color: word.accent ? accent : ink,
            // Cream on the darkened bottom gets a soft shadow for the bright
            // spots a photograph leaves there; dark ink on a light wall needs none.
            ...(L.tone === 'cream' ? { textShadow: '0 2px 14px rgba(0,0,0,0.35)' } : {}),
            marginRight: wi < line.length - 1 ? Math.round(L.size * 0.26) : 0,
          },
        }, word.text),
      ),
    ),
  );
  // The bottom band is carried by a soft darkening of the lower part of the
  // picture — as the feed's "The Science of Consistent Sleep" is — and by
  // nothing else: no wash, no band. The top band sits on the picture as it
  // is, above the people, as "Meet Our Team" does. Deliberately gentle: the
  // picture stays the picture.
  const shade = L.band === 'bottom'
    ? [h('div', {
        key: 'shade',
        style: {
          position: 'absolute', left: 0, bottom: 0, width: COVER.width, height: Math.round(COVER.height * 0.5), display: 'flex',
          backgroundImage: 'linear-gradient(180deg, rgba(24,18,14,0) 0%, rgba(24,18,14,0.22) 42%, rgba(24,18,14,0.56) 100%)',
        },
      })]
    : [];
  return h(
    'div',
    { style: { width: COVER.width, height: COVER.height, position: 'relative', display: 'flex', background: '#F4EEE6', overflow: 'hidden' } },
    h('img', { key: 'photo', src: input.photoDataUrl, width: COVER.width, height: COVER.height, style: { position: 'absolute', top: 0, left: 0, width: COVER.width, height: COVER.height, objectFit: 'cover', objectPosition: 'center top' } }),
    ...shade,
    h(
      'div',
      { key: 'title', style: { position: 'absolute', top: L.y, left: L.x, width: L.width, display: 'flex', flexDirection: 'column', alignItems: justify } },
      ...lineEls,
      h('div', { key: 'rule', style: { display: 'flex', width: L.rule.width, height: 3, marginTop: L.rule.gap, background: accent, opacity: 0.8 } }),
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
  const res = new ImageResponse(coverElement({ title: input.title, photoDataUrl, family, italic, headTopPct: input.headTopPct, clearSide: input.clearSide, quiet: input.quiet, quietSide: input.quietSide }), { width: COVER.width, height: COVER.height, fonts });
  const png = Buffer.from(await res.arrayBuffer());
  return { png, width: COVER.width, height: COVER.height, family };
}

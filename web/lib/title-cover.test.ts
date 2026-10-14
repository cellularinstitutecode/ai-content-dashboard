// The feed's own way with titles: a short sentence, large, left-aligned in
// the quiet side of the photograph, the words that carry it in rust italic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { ImageResponse } from 'next/og.js';
import { COVER, TITLE_COLUMN, TITLE_MARGIN, fitSize, layoutTitle, parseEmphasis, placeTitle, plainTitle, wrapWords, type TitleWord } from './title-cover-layout.ts';
import { renderTitleCover, coverElement } from './title-cover.ts';
import { pngSize } from './brand-card.ts';

const text = (lines: TitleWord[][]) => lines.map((l) => l.map((w) => w.text).join(' ')).join(' / ');

test('*markers* say which words carry the line; without them the opening line does', () => {
  assert.deepEqual(parseEmphasis('Hydration is *part* of how the body stays *balanced*.').map((w) => [w.text, w.accent]), [
    ['Hydration', false], ['is', false], ['part', true], ['of', false], ['how', false], ['the', false], ['body', false], ['stays', false], ['balanced.', true],
  ]);
  assert.ok(parseEmphasis('Hydration is *part* of it.').find((w) => w.text === 'part')!.italic, 'a marked word is italic');
  assert.deepEqual(parseEmphasis('Your nervous system deserves *space to settle*.').filter((w) => w.accent).map((w) => w.text), ['space', 'to', 'settle.']);
  const plain = layoutTitle('Your cells shape how your body responds.');
  assert.ok(plain.lines[0].every((w) => w.accent && !w.italic), 'the first line carries it, in roman rust');
  assert.ok(plain.lines.slice(1).every((l) => l.every((w) => !w.accent)));
  assert.equal(plainTitle('Hydration is *part* of how the body stays *balanced*.'), 'Hydration is part of how the body stays balanced.');
});

test('the sentence wraps into a column a little over half the frame, in short lines, as large as fits', () => {
  const words = parseEmphasis('Hydration is part of how the body stays balanced.');
  const { size, lines } = fitSize(words);
  assert.ok(size >= 76 && size <= 132, String(size));
  assert.ok(lines.length >= 3 && lines.length <= 5, text(lines));
  assert.equal(wrapWords(words, 400), null, 'a word that cannot fit the column at this size: smaller');
  assert.ok(layoutTitle('Fiber first.').size > layoutTitle('Your nervous system deserves space to settle.').size);
});

test('the block sits beside the subject on the clear side, above low heads, else bottom-left', () => {
  assert.deepEqual(placeTitle({ clearSide: 'right' }), { side: 'right', band: 'middle' });
  assert.deepEqual(placeTitle({ clearSide: 'left', headTopPct: 10 }), { side: 'left', band: 'middle' });
  assert.deepEqual(placeTitle({ headTopPct: 48 }), { side: 'left', band: 'top' });
  assert.deepEqual(placeTitle({ headTopPct: 20 }), { side: 'left', band: 'bottom' });
  assert.deepEqual(placeTitle({}), { side: 'left', band: 'bottom' });
  const right = layoutTitle('Hydration is *part* of how the body stays *balanced*.', { clearSide: 'right' });
  assert.equal(right.x, COVER.width - TITLE_MARGIN - TITLE_COLUMN);
  assert.ok(right.y > 200 && right.y + right.height < COVER.height - 200, 'in the middle band');
  const top = layoutTitle('Your cells shape how your body responds.', { headTopPct: 48 });
  assert.equal(top.x, TITLE_MARGIN);
  assert.ok(top.y + top.height <= (48 / 83.3) * COVER.height - 80, 'clears the heads');
  const bottom = layoutTitle('Your nervous system deserves space to settle.', { headTopPct: 20 });
  assert.ok(bottom.y + bottom.height <= COVER.height - 140 && bottom.y > COVER.height * 0.4, 'low in the frame');
  // The block never swallows the picture: at most four lines, under half the frame tall.
  for (const t of ['Hydration is *part* of how the body stays *balanced*.', 'Your nervous system deserves space to settle.']) {
    const L = layoutTitle(t);
    assert.ok(L.lines.length <= 4 && L.height <= COVER.height * 0.5, t + ': ' + L.lines.length + ' lines, ' + L.height + 'px');
  }
});

test('the cover tree carries the exact words, left-aligned, the accented ones in rust', () => {
  const el = coverElement({ title: 'Hydration is *part* of how the body stays *balanced*.', photoDataUrl: 'data:image/png;base64,AA==', family: 'Instrument Serif', italic: true, clearSide: 'left' });
  const words: { text: string; color: string; italic: boolean }[] = [];
  const walk = (n: any) => {
    if (n == null || typeof n === 'boolean') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const kids = n.props?.children;
    if (typeof kids === 'string') { words.push({ text: kids, color: n.props.style.color, italic: n.props.style.fontStyle === 'italic' }); return; }
    walk(kids);
  };
  walk(el);
  assert.deepEqual(words.map((w) => w.text), ['Hydration', 'is', 'part', 'of', 'how', 'the', 'body', 'stays', 'balanced.']);
  const part = words.find((w) => w.text === 'part')!;
  assert.equal(part.italic, true);
  assert.equal(part.color, '#9F4D27');
  assert.equal(words.find((w) => w.text === 'Hydration')!.color, '#2E2620');
});

test('a cover renders to a 1080×1350 PNG over a photograph', async () => {
  // A stand-in "photograph": a warm gradient rendered by the same engine.
  const bg = new ImageResponse(h('div', { style: { width: 1024, height: 1536, display: 'flex', backgroundImage: 'linear-gradient(180deg,#EFE6DA,#C9A98A)' } }), { width: 1024, height: 1536 });
  const bytes = Buffer.from(await bg.arrayBuffer());
  const out = await renderTitleCover({ title: 'Your nervous system deserves *space to settle*.', photo: { bytes, contentType: 'image/png' }, clearSide: 'left' });
  assert.deepEqual(pngSize(out.png), { width: 1080, height: 1350 });
  assert.equal(out.family, 'Instrument Serif');
});

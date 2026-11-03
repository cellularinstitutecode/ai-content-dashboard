// The feed's own way with titles: a short sentence, large, centred above the
// people when there is room and at the bottom on a soft darkening when there
// is not, the words that carry it in rust italic. No wash, never on a face.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { ImageResponse } from 'next/og.js';
import { COVER, SIDE_COLUMN, TITLE_ACCENT_ON_DARK, TITLE_COLUMN, TITLE_CREAM, TITLE_MARGIN, TOP_BAND_MIN_HEAD_PCT, fitSize, layoutTitle, parseEmphasis, placeTitle, plainTitle, wrapWords, type TitleWord } from './title-cover-layout.ts';
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

test('the sentence wraps into the frame less its margins, in short lines, as large as fits', () => {
  assert.equal(TITLE_COLUMN, COVER.width - 2 * TITLE_MARGIN);
  const words = parseEmphasis('Hydration is part of how the body stays balanced.');
  const { size, lines } = fitSize(words);
  assert.ok(size >= 76 && size <= 132, String(size));
  assert.ok(lines.length >= 2 && lines.length <= 4, text(lines));
  assert.equal(wrapWords(words, 400), null, 'a word that cannot fit the column at this size: smaller');
  assert.ok(layoutTitle('Fiber first.').size > layoutTitle('Your nervous system deserves space to settle.').size);
});

test('the block goes above the people when there is room, else to the bottom; never beside them, whatever side was called clear', () => {
  assert.deepEqual(placeTitle({ headTopPct: 70 }), { side: 'left', band: 'top' });
  assert.deepEqual(placeTitle({ headTopPct: TOP_BAND_MIN_HEAD_PCT }), { side: 'left', band: 'top' });
  // A head the check puts halfway down may really be a fifth of the way down: the bottom.
  assert.deepEqual(placeTitle({ headTopPct: 50 }), { side: 'left', band: 'bottom' });
  assert.deepEqual(placeTitle({ headTopPct: 20 }), { side: 'left', band: 'bottom' });
  // Some room, and the picture says its top is the plain band: above them (a ceiling over a team).
  assert.deepEqual(placeTitle({ headTopPct: 40, quiet: 'top' }), { side: 'left', band: 'top' });
  assert.deepEqual(placeTitle({ headTopPct: 40, quiet: 'bottom' }), { side: 'left', band: 'bottom' });
  assert.deepEqual(placeTitle({ headTopPct: 40 }), { side: 'left', band: 'bottom' });
  assert.deepEqual(placeTitle({ headTopPct: 20, quiet: 'top' }), { side: 'left', band: 'bottom' }, 'a head that high leaves no room, quiet or not');
  assert.deepEqual(placeTitle({ quiet: 'top' }), { side: 'left', band: 'bottom' }, 'no head measured: no room assumed');
  assert.deepEqual(placeTitle({ headTopPct: 20, clearSide: 'right' }), { side: 'left', band: 'bottom' }, 'the side hint is ignored');
  assert.deepEqual(placeTitle({ clearSide: 'left' }), { side: 'left', band: 'bottom' });
  assert.deepEqual(placeTitle({}), { side: 'left', band: 'bottom' }, 'no head measured: no room assumed');
  // Centred: the block spans the frame less its margins, from the left margin.
  const top = layoutTitle('Your cells shape how your body responds.', { headTopPct: 60 });
  assert.equal(top.x, TITLE_MARGIN);
  assert.equal(top.width, TITLE_COLUMN);
  assert.equal(top.tone, 'ink');
  assert.ok(top.y + top.height <= COVER.height * 0.36, 'never below a third of the frame');
  assert.ok(top.lines.length <= 2, 'two lines when two can be had');
  const bottom = layoutTitle('Your nervous system deserves space to settle.', { headTopPct: 20, clearSide: 'right' });
  assert.equal(bottom.x, TITLE_MARGIN);
  assert.equal(bottom.band, 'bottom');
  assert.equal(bottom.tone, 'cream');
  assert.ok(bottom.y + bottom.height <= COVER.height - 100 && bottom.y > COVER.height * 0.6, 'low in the frame');
  // A person on one side of the band: the block keeps to the other side, narrower, aligned to that edge.
  const left = layoutTitle('Before, During and After Your Visit', { headTopPct: 20, quietSide: 'left' });
  assert.equal(left.align, 'left');
  assert.equal(left.x, TITLE_MARGIN);
  assert.equal(left.width, SIDE_COLUMN);
  const right = layoutTitle('Before, During and After Your Visit', { headTopPct: 20, quietSide: 'right' });
  assert.equal(right.align, 'right');
  assert.equal(right.x + right.width, COVER.width - TITLE_MARGIN);
  assert.equal(layoutTitle('Before, During and After Your Visit', { headTopPct: 20 }).align, 'center');
  // The block never swallows the picture: at most four lines, well under half the frame tall.
  for (const t of ['Hydration is *part* of how the body stays *balanced*.', 'Your nervous system deserves space to settle.']) {
    const L = layoutTitle(t);
    assert.ok(L.lines.length <= 4 && L.height <= COVER.height * 0.34, t + ': ' + L.lines.length + ' lines, ' + L.height + 'px');
  }
});

/** Every element's style, flattened, plus the words. */
function flatten(el: any): { words: { text: string; color: string; italic: boolean }[]; styles: Record<string, unknown>[] } {
  const words: { text: string; color: string; italic: boolean }[] = [];
  const styles: Record<string, unknown>[] = [];
  const walk = (n: any) => {
    if (n == null || typeof n === 'boolean') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props?.style) styles.push(n.props.style);
    const kids = n.props?.children;
    if (typeof kids === 'string') { words.push({ text: kids, color: n.props.style.color, italic: n.props.style.fontStyle === 'italic' }); return; }
    walk(kids);
  };
  walk(el);
  return { words, styles };
}

test('the cover tree carries the exact words, centred; dark ink above the people, cream on the darkened bottom; no wash', () => {
  const top = flatten(coverElement({ title: 'Hydration is *part* of how the body stays *balanced*.', photoDataUrl: 'data:image/png;base64,AA==', family: 'Instrument Serif', italic: true, headTopPct: 70 }));
  assert.deepEqual(top.words.map((w) => w.text), ['Hydration', 'is', 'part', 'of', 'how', 'the', 'body', 'stays', 'balanced.']);
  const part = top.words.find((w) => w.text === 'part')!;
  assert.equal(part.italic, true);
  assert.equal(part.color, '#9F4D27');
  assert.equal(top.words.find((w) => w.text === 'Hydration')!.color, '#2E2620');
  // Centred lines, and nothing painted behind them: no cream wash, no darkening up top.
  assert.ok(top.styles.some((s) => s.justifyContent === 'center'));
  assert.ok(!top.styles.some((s) => typeof s.backgroundImage === 'string'), 'no wash and no shade in the top band');
  assert.ok(!top.styles.some((s) => String(s.backgroundImage || '').includes('247,242,235')), 'the cream columns are gone');

  const bottom = flatten(coverElement({ title: 'The Science of Consistent *Sleep*.', photoDataUrl: 'data:image/png;base64,AA==', family: 'Instrument Serif', italic: true, headTopPct: 12, clearSide: 'right' }));
  assert.equal(bottom.words.find((w) => w.text === 'Sleep.')!.color, TITLE_ACCENT_ON_DARK);
  assert.equal(bottom.words.find((w) => w.text === 'The')!.color, TITLE_CREAM);
  const shades = bottom.styles.filter((s) => typeof s.backgroundImage === 'string');
  assert.equal(shades.length, 1, 'one soft darkening over the lower half, and nothing else');
  assert.match(String(shades[0].backgroundImage), /^linear-gradient\(180deg, rgba\(24,18,14,0\) 0%/);
  assert.ok(Number(shades[0].height) <= COVER.height * 0.5);
});

test('a cover renders to a 1080×1350 PNG over a photograph', async () => {
  // A stand-in "photograph": a warm gradient rendered by the same engine.
  const bg = new ImageResponse(h('div', { style: { width: 1024, height: 1536, display: 'flex', backgroundImage: 'linear-gradient(180deg,#EFE6DA,#C9A98A)' } }), { width: 1024, height: 1536 });
  const bytes = Buffer.from(await bg.arrayBuffer());
  const out = await renderTitleCover({ title: 'Your nervous system deserves *space to settle*.', photo: { bytes, contentType: 'image/png' }, clearSide: 'left' });
  assert.deepEqual(pngSize(out.png), { width: 1080, height: 1350 });
  assert.equal(out.family, 'Instrument Serif');
});

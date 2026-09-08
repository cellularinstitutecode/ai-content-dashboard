import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrandCard, cardElement, loadFonts, pngSize } from './brand-card.ts';
import { DEFAULT_VISUAL } from './brand-visual.ts';

// These render real PNGs through next/og (satori + resvg), with the stand-in
// fonts shipped in public/fonts/standin — no network, no keys.

test('a portrait card renders to a 1080×1350 PNG', async () => {
  const out = await renderBrandCard({
    spec: { headline: 'What is a stem cell?', body: 'A stem cell can divide and generate new cells with characteristics similar to the original cell.', kicker: 'Basic cell biology', size: 'portrait', ground: 'paper', index: 1, total: 3, aviso: '2623022002A00090', standIn: false },
    visual: DEFAULT_VISUAL,
  });
  assert.deepEqual(pngSize(out.png), { width: 1080, height: 1350 });
  assert.ok(out.png.length > 20_000, 'a painted card is not a blank: ' + out.png.length + ' bytes');
});

test('square and landscape sizes come out at their own dimensions', async () => {
  const sq = await renderBrandCard({ spec: { headline: 'Sterility is not assumed: it is verified.', size: 'square', ground: 'rust', index: 1, total: 1, standIn: false } });
  assert.deepEqual(pngSize(sq.png), { width: 1080, height: 1080 });
  const ls = await renderBrandCard({ spec: { headline: 'The cost of being always on', size: 'landscape', ground: 'black', index: 2, total: 2, standIn: false } });
  assert.deepEqual(pngSize(ls.png), { width: 1200, height: 630 });
});

test('without licensed brand fonts the card is marked as stand-in type', async () => {
  const fonts = await loadFonts();
  // The repo ships only the open stand-ins; a deployment with Canela/Nexa in
  // public/fonts/brand flips this to false and drops the corner note.
  assert.equal(fonts.standIn, true);
  const out = await renderBrandCard({ spec: { headline: 'x', size: 'square', ground: 'pearl', index: 1, total: 1, standIn: false } });
  assert.equal(out.standIn, true);
});

test('the card tree carries the words exactly, the slide count, the permit line and the marks', async () => {
  const fonts = await loadFonts();
  const el = cardElement({
    spec: { headline: 'Not all stem cells are the same.', body: 'Their behavior depends on the tissue of origin.', kicker: 'Important', size: 'portrait', ground: 'pearl', index: 3, total: 8, aviso: '2623022002A00090', standIn: true },
    visual: DEFAULT_VISUAL,
  }, fonts);
  const text: string[] = [];
  let svgs = 0;
  const walk = (n: any) => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') { text.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'svg') svgs++;
    const c = n.props?.children;
    if (c !== undefined) walk(c);
  };
  walk(el);
  assert.ok(text.includes('Not all stem cells are the same.'));
  assert.ok(text.includes('Their behavior depends on the tissue of origin.'));
  assert.ok(text.includes('IMPORTANT'), 'the kicker is set in caps');
  assert.ok(text.includes('3/8'));
  assert.ok(text.includes('AVISO DE PUBLICIDAD: 2623022002A00090'));
  assert.ok(text.some((t) => /^stand-in .*type · add /.test(t)), 'the corner note names the stand-in role and the face to add');
  assert.ok(svgs >= 3, 'brandmark top, watermark, wordmark bottom: ' + svgs);
  // Pearl ground → Eerie Black ink on the headline.
  const headline = JSON.stringify(el).match(/"color":"(#[0-9A-F]{6})","letterSpacing"/i);
  assert.equal(headline?.[1], '#282119');
});

test('a photo cover puts the picture on top and the words on a paper panel', async () => {
  // A 1×1 JPEG is enough to exercise the photo path.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAC//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
  const out = await renderBrandCard({
    spec: { headline: 'Stem cells and knee pain', size: 'portrait', ground: 'photo', index: 1, total: 4, standIn: false },
    photo: { bytes: jpeg, contentType: 'image/jpeg' },
  });
  assert.deepEqual(pngSize(out.png), { width: 1080, height: 1350 });
  const fonts = await loadFonts();
  const el = cardElement({ spec: { headline: 'x', size: 'portrait', ground: 'photo', index: 1, total: 1, standIn: false }, photo: { bytes: jpeg, contentType: 'image/jpeg' } }, fonts);
  const s = JSON.stringify(el);
  assert.match(s, /"type":"img"/);
  assert.doesNotMatch(s, /"opacity":0\.07/, 'no watermark behind a photograph');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { ImageResponse } from 'next/og.js';
import { splitTitleLines, titleFontSize, isConnector, fitTitle } from './title-cover-layout.ts';
import { renderTitleCover, coverElement } from './title-cover.ts';
import { pngSize } from './brand-card.ts';

test('titles break the way the reference does', () => {
  assert.deepEqual(splitTitleLines('The Importance of Nutrition'), ['The Importance', 'of Nutrition']);
  assert.deepEqual(splitTitleLines('Sleep and Recovery'), ['Sleep and Recovery']);
  assert.deepEqual(splitTitleLines('Protein and Recovery'), ['Protein', 'and Recovery']);
  assert.deepEqual(splitTitleLines('Walk, Swim, Move'), ['Walk, Swim, Move']);
  const long = splitTitleLines('Compare Evaluations, Not Just Treatments');
  assert.ok(long.length >= 2 && long.every((l) => l.length <= 24), long.join(' / '));
});

test('connectors go italic, never the first word; long lines set smaller', () => {
  assert.equal(isConnector('of', 2), true);
  assert.equal(isConnector('Of', 0), false);
  assert.equal(isConnector('Nutrition', 3), false);
  assert.ok(titleFontSize(['Short']) > titleFontSize(['A considerably longer line']));
});

test('the cover tree carries the exact words and nothing else written', () => {
  const el = coverElement({ title: 'The Importance of Nutrition', photoDataUrl: 'data:image/png;base64,AA==', family: 'Instrument Serif', italic: true });
  const words: string[] = [];
  const walk = (n: any) => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') { words.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    walk(n.props?.children);
  };
  walk(el);
  assert.deepEqual(words, ['The', 'Importance', 'of', 'Nutrition']);
});

test('a cover renders to a 1080×1350 PNG over a photograph', async () => {
  // A stand-in "photograph": a warm gradient rendered by the same engine.
  const bg = new ImageResponse(h('div', { style: { width: 1024, height: 1536, display: 'flex', backgroundImage: 'linear-gradient(180deg,#EFE6DA,#C9A98A)' } }), { width: 1024, height: 1536 });
  const bytes = Buffer.from(await bg.arrayBuffer());
  const out = await renderTitleCover({ title: 'The Importance of Nutrition', photo: { bytes, contentType: 'image/png' } });
  assert.deepEqual(pngSize(out.png), { width: 1080, height: 1350 });
  assert.equal(out.family, 'Instrument Serif');
});

test('the title fits itself above the heads the photograph gave us', () => {
  const lines = splitTitleLines('Protein and Recovery');
  const free = fitTitle(lines, null);
  const tight = fitTitle(lines, 26);   // heads high in the frame
  const roomy = fitTitle(lines, 45);   // heads low, as asked for
  assert.equal(roomy.size, free.size, 'plenty of wall: the classic setting');
  assert.ok(tight.size < free.size || tight.top < free.top, 'crowded: smaller and/or higher');
  const blockBottom = (f: { size: number; top: number }) => f.top + lines.length * f.size * 1.08 + 36;
  assert.ok(blockBottom(tight) <= (26 / 83.3) * 1350 - 60, 'and it clears the heads');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_SIZES, groundHex, inkFor, headlineSize, footerText, slidesFromPack, normalizeSlides,
  normalizeGround, normalizeSize, groundForSlide,
} from './brand-card-layout.ts';
import { DEFAULT_VISUAL, contrast } from './brand-visual.ts';

test('card sizes are the formats the team posts in', () => {
  assert.deepEqual([CARD_SIZES.portrait.width, CARD_SIZES.portrait.height], [1080, 1350]);
  assert.deepEqual([CARD_SIZES.square.width, CARD_SIZES.square.height], [1080, 1080]);
});

test('every ground gets ink that reads on it, from the brand palette', () => {
  for (const g of ['paper', 'pearl', 'rust', 'cocoa', 'seal', 'black'] as const) {
    const { ink, accent } = inkFor(g);
    assert.ok(contrast(groundHex(g), ink) >= 3, g + ' ink contrast (large-text AA)');
    assert.notEqual(accent.toUpperCase(), groundHex(g).toUpperCase(), g + ': the accent is never the ground colour');
  }
  // The guide's pairings: Pearl on Rust, Eerie Black on Pearl.
  assert.equal(inkFor('rust').ink, '#E0D2B7');
  assert.equal(inkFor('pearl').ink, '#282119');
});

test('grounds come from the profile palette by role, so a re-coloured brand re-colours its cards', () => {
  const v = { ...DEFAULT_VISUAL, palette: [
    { name: 'Ink', hex: '#101010', role: 'dark' as const },
    { name: 'Teal', hex: '#0A6B6B', role: 'accent' as const },
    { name: 'Sand', hex: '#F1E7D0', role: 'light' as const },
  ] };
  assert.equal(groundHex('rust', v), '#0A6B6B');
  assert.equal(groundHex('pearl', v), '#F1E7D0');
  assert.equal(groundHex('black', v), '#101010');
  assert.equal(groundHex('seal', v), '#101010', 'a palette with one dark falls back to it');
});

test('long headlines shrink instead of wrapping into a paragraph', () => {
  assert.ok(headlineSize('Short', 'portrait') > headlineSize('A headline of about forty characters here', 'portrait'));
  assert.ok(headlineSize('x'.repeat(100), 'portrait') >= 52);
  assert.ok(headlineSize('Short', 'landscape') < headlineSize('Short', 'portrait'), 'landscape cards set smaller');
});

test('the footer counts slides only when there is more than one', () => {
  assert.equal(footerText(1, 1), '');
  assert.equal(footerText(3, 8), '3/8');
});

test('a pack becomes the gallery\'s slide structure: cover, then one idea per paragraph, never the REF/AVISO/hashtag lines', () => {
  const pack = {
    instagram:
      'Stem cells and knee pain: what the evidence says.\n\n' +
      'Peer-reviewed studies report pain-score improvements at twelve months for many patients. Every case still starts with a proper evaluation.\n\n' +
      'Not all stem cells are the same.\n\n' +
      '#stemcells #kneepain\n' +
      'REF: Rogeri PS et al. (2021) Nutrients 14(1):52. DOI: 10.3390/nu14010052\n\n' +
      'AVISO DE PUBLICIDAD: 2623022002A00090',
  };
  const slides = slidesFromPack('Stem cells for knees', pack);
  assert.equal(slides[0].headline, 'Stem cells for knees');
  assert.equal(slides[0].kicker, 'Cellular Institute');
  assert.equal(slides[1].headline, 'Stem cells and knee pain: what the evidence says.');
  assert.equal(slides[2].headline, 'Peer-reviewed studies report pain-score improvements at twelve months for many patients');
  assert.match(slides[2].body || '', /^Every case still starts/);
  assert.equal(slides[3].headline, 'Not all stem cells are the same.');
  assert.equal(slides.length, 4, 'hashtags, REF and AVISO are not slides');
  const all = JSON.stringify(slides);
  assert.doesNotMatch(all, /REF:|AVISO|#stemcells/);
});

test('a carousel is capped at eight slides', () => {
  const pack = { instagram: Array.from({ length: 20 }, (_, i) => 'Idea number ' + i + '.').join('\n\n') };
  assert.equal(slidesFromPack('t', pack).length, 8);
});

test('typed slides are cleaned and capped; a slide with no headline is dropped', () => {
  const s = normalizeSlides([{ headline: '  Hello   world ', body: 'b'.repeat(500), kicker: 'k' }, { body: 'orphan' }, 'junk', null]);
  assert.equal(s.length, 1);
  assert.equal(s[0].headline, 'Hello world');
  assert.equal(s[0].body?.length, 260);
  assert.equal(s[0].kicker, 'k');
  assert.deepEqual(normalizeSlides('nope'), []);
});

test('unknown grounds and sizes fall back to paper / portrait', () => {
  assert.equal(normalizeGround('neon'), 'paper');
  assert.equal(normalizeGround('rust'), 'rust');
  assert.equal(normalizeSize('huge'), 'portrait');
  assert.equal(normalizeSize('square'), 'square');
});

test('a carousel opens on the strong colour and then alternates paper and pearl', () => {
  assert.equal(groundForSlide('paper', 1, 5), 'rust');
  assert.equal(groundForSlide('rust', 1, 5), 'rust');
  assert.equal(groundForSlide('paper', 2, 5), 'paper');
  assert.equal(groundForSlide('paper', 3, 5), 'pearl');
  assert.equal(groundForSlide('paper', 1, 1), 'paper', 'a single card keeps what was asked for');
  assert.equal(groundForSlide('photo', 1, 3), 'photo');
  assert.equal(groundForSlide('photo', 2, 3), 'paper', 'only the cover carries the photograph');
});

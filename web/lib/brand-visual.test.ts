import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VISUAL, PAPER, normalizeVisual, textColorOn, contrast, roleOf, visualPromptBlock, brandFitRubric,
} from './brand-visual.ts';

test('an empty or missing visual falls back to the brand guide, not to nothing', () => {
  for (const raw of [undefined, null, {}, 'junk', 42, { palette: 'not-an-array' }]) {
    const v = normalizeVisual(raw);
    assert.deepEqual(v.palette, DEFAULT_VISUAL.palette);
    assert.equal(v.materials, DEFAULT_VISUAL.materials);
    assert.equal(v.photography, DEFAULT_VISUAL.photography);
    assert.equal(v.fonts.headline, 'Canela');
  }
});

test('colours that are not real hex codes are dropped, and one survivor is not a palette', () => {
  const v = normalizeVisual({ palette: [{ name: 'Rust', hex: '#9F4D27' }, { name: 'bad', hex: 'red' }, { hex: '#12345' }] });
  // A single valid colour cannot pair text with ground, so the guide's palette stands in.
  assert.deepEqual(v.palette, DEFAULT_VISUAL.palette);
  const ok = normalizeVisual({ palette: [{ name: 'Ink', hex: '#111111' }, { hex: '#eeeeee' }] });
  assert.deepEqual(ok.palette.map((c) => c.hex), ['#111111', '#EEEEEE']);
  assert.equal(ok.palette[1].name, '#EEEEEE', 'a nameless colour is named by its hex');
});

test('roles are inferred from lightness when the profile does not say', () => {
  assert.equal(roleOf('#282119'), 'dark');
  assert.equal(roleOf('#E0D2B7'), 'light');
  assert.equal(roleOf('#9F4D27'), 'accent');
  const v = normalizeVisual({ palette: [{ hex: '#282119' }, { hex: '#E0D2B7', role: 'accent' }] });
  assert.equal(v.palette[1].role, 'accent', 'an explicit role is kept');
});

test('free text is capped so a profile can never blow up a prompt', () => {
  const v = normalizeVisual({ materials: 'x'.repeat(5000), never: Array.from({ length: 20 }, (_, i) => 'rule ' + i) });
  assert.ok(v.materials.length <= 400);
  assert.equal(v.never.length, 8);
});

test('text colour on a ground is always the highest-contrast palette colour', () => {
  // Pearl on Rust and Seal Brown/Eerie Black on Pearl — the guide's own logo-usage pairings.
  assert.equal(textColorOn('#9F4D27'), '#E0D2B7');
  assert.equal(textColorOn('#282119'), '#E0D2B7');
  assert.equal(textColorOn('#E0D2B7'), '#282119');
  assert.equal(textColorOn(PAPER), '#282119');
  for (const ground of DEFAULT_VISUAL.palette.map((c) => c.hex).concat(PAPER)) {
    // Cards set display-size type; 3:1 is the WCAG AA floor for large text and
    // is what the guide's own Pearl-on-Rust pairing achieves (3.9:1).
    assert.ok(contrast(ground, textColorOn(ground)) >= 3, ground + ' must reach large-text AA contrast');
  }
});

test('the prompt block names every colour with its hex and carries the never-list', () => {
  const block = visualPromptBlock(DEFAULT_VISUAL);
  for (const c of DEFAULT_VISUAL.palette) assert.ok(block.includes(c.hex), 'missing ' + c.hex);
  assert.match(block, /rust \(#9F4D27\)/);
  assert.match(block, /Never: .*stock-photo/);
  assert.match(block, /black scrubs/);
});

test('the brand-fit rubric is advisory language and names the palette', () => {
  const r = brandFitRubric(DEFAULT_VISUAL);
  assert.match(r, /advisory/);
  assert.match(r, /Eerie Black, Seal Brown, Rust, Cocoa Brown, Pearl/);
  assert.match(r, /0-100/);
});

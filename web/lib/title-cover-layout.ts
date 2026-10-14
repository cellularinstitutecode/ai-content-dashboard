// web/lib/title-cover-layout.ts
// The decisions behind a title cover — the feed's own way with titles — as
// pure functions, so the look can be unit-tested without rendering a pixel.
// lib/title-cover.ts paints.
//
// THE BASELINE IS THE CLINIC'S INSTAGRAM. Its photo posts carry a short
// sentence in large serif type — "Your cells shape how your body responds.",
// "Hydration is *part* of how the body stays *balanced*.", "Your nervous
// system deserves space to settle." — set LEFT-ALIGNED in the quiet side of
// the photograph beside the subject, never pinned small and centred at the
// top. The words that carry the line are in the brand's rust, in italic; the
// rest in the dark brown; a short rule beneath. These rules reproduce that.
//
// Pure: no imports.

export const COVER = { width: 1080, height: 1350 } as const;

export type Side = 'left' | 'right';
export type Band = 'top' | 'middle' | 'bottom';

/** `accent`: set in the brand's rust. `italic`: marked with *asterisks* by hand or by the writer; the default first-line accent stays roman, as "Your nervous system" does on the feed. */
export type TitleWord = { text: string; accent: boolean; italic: boolean };

export type TitleLayout = {
  /** The wrapped lines, each word with its colour. */
  lines: TitleWord[][];
  /** Font size, px, on the 1080-wide cover. */
  size: number;
  /** The block's left edge and top, px. */
  x: number;
  y: number;
  /** The column the lines wrap in, px. */
  width: number;
  /** Height of the block (lines and rule), px. */
  height: number;
  side: Side;
  band: Band;
  /** The short rule under the block: its width and the gap above it, px. */
  rule: { width: number; gap: number };
};

/** The ink: the brand's darkest warm brown, softened a touch for a light wall. */
export const TITLE_INK = '#2E2620';
/** The accent: the brand's rust, for the words that carry the line. */
export const TITLE_ACCENT = '#9F4D27';
/** The cream the wash behind the words is made of (r,g,b). */
export const TITLE_WASH_RGB = '247,242,235';

/** The column the title wraps in: a little over half the frame, so it sits beside the subject. */
export const TITLE_COLUMN = 620;
/** The side margin the block keeps from the edge. */
export const TITLE_MARGIN = 72;
/** Sizes tried, largest first; the first that wraps into at most MAX_LINES and under MAX_BLOCK wins. */
const SIZES = [132, 120, 110, 100, 92, 84, 76, 70, 64];
const MAX_LINES = 4;
/** The block never takes more than this much of the frame's height: the picture stays the picture. */
const MAX_BLOCK = Math.round(COVER.height * 0.44);
/** The stand-in serif's average glyph width and word gap, as a fraction of the size. */
const GLYPH = 0.47;
const SPACE = 0.26;
const LINE_HEIGHT = 1.06;

/** The title without its *emphasis* markers, for alt text and the record. */
export function plainTitle(title: string): string {
  return String(title || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The words, each knowing whether it carries the line.
 *
 * `*like this*` marks the words to set in rust italic — the title writer
 * marks one or two, and a person can type them. With no markers at all, the
 * opening words carry it (the first line once wrapped), as "Your nervous
 * system" does on the feed.
 */
export function parseEmphasis(title: string): TitleWord[] {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const out: TitleWord[] = [];
  let accent = false;
  for (const raw of text.split(' ')) {
    let word = raw;
    let starts = false;
    let ends = false;
    while (word.startsWith('*')) { word = word.slice(1); starts = true; }
    // A closing marker may sit before trailing punctuation: "*balanced*."
    const m = /^(.*?)\*+([.,;:!?…"”’']*)$/.exec(word);
    if (m) { word = m[1] + m[2]; ends = true; }
    if (!word) continue;
    if (starts) accent = true;
    out.push({ text: word, accent, italic: accent });
    if (ends) accent = false;
  }
  return out;
}

function widthOf(words: readonly TitleWord[], size: number): number {
  const chars = words.reduce((n, w) => n + w.text.length, 0);
  return chars * size * GLYPH + Math.max(0, words.length - 1) * size * SPACE;
}

/** Greedy wrap into the column at this size; null when a single word cannot fit. */
export function wrapWords(words: readonly TitleWord[], size: number, width = TITLE_COLUMN): TitleWord[][] | null {
  const lines: TitleWord[][] = [];
  let line: TitleWord[] = [];
  for (const w of words) {
    if (widthOf([w], size) > width) return null;
    const next = [...line, w];
    if (line.length && widthOf(next, size) > width) { lines.push(line); line = [w]; }
    else line = next;
  }
  if (line.length) lines.push(line);
  return lines;
}

/** The largest size whose wrap fits the column in at most MAX_LINES lines and under MAX_BLOCK tall. */
export function fitSize(words: readonly TitleWord[], width = TITLE_COLUMN): { size: number; lines: TitleWord[][] } {
  for (const size of SIZES) {
    const lines = wrapWords(words, size, width);
    if (lines && lines.length <= MAX_LINES && lines.length * size * LINE_HEIGHT <= MAX_BLOCK) return { size, lines };
  }
  const size = SIZES[SIZES.length - 1];
  return { size, lines: wrapWords(words, size, width) || [words.slice()] };
}

export type LayoutHints = {
  /** Where the highest head starts, as a percentage of the photograph's height (vision check). */
  headTopPct?: number | null;
  /** The side of the frame the vision check found quiet, where the title can sit beside the subject. */
  clearSide?: Side | null;
};

/**
 * Where the block goes.
 *
 *   a clear side reported  → beside the subject, in the middle of that side
 *                            (the feed's "Hydration is part of…").
 *   heads low in the frame → above them, top-left.
 *   otherwise              → bottom-left, over the lower part of the picture
 *                            (the feed's "Your nervous system…").
 *
 * `headTopPct` is measured on the photograph; the cover shows its top 83.3%
 * (a 2:3 photo cropped to 4:5 from the top), so it is converted here.
 */
export function placeTitle(hints: LayoutHints): { side: Side; band: Band } {
  if (hints.clearSide === 'left' || hints.clearSide === 'right') return { side: hints.clearSide, band: 'middle' };
  const head = typeof hints.headTopPct === 'number' && Number.isFinite(hints.headTopPct) ? hints.headTopPct : null;
  if (head != null && head >= 40) return { side: 'left', band: 'top' };
  return { side: 'left', band: 'bottom' };
}

/** The whole layout for a title on a cover. */
export function layoutTitle(title: string, hints: LayoutHints = {}): TitleLayout {
  const words = parseEmphasis(title);
  const { side, band } = placeTitle(hints);
  let { size, lines } = fitSize(words);
  // No markers: the opening line carries the sentence.
  if (words.length && !words.some((w) => w.accent)) lines = lines.map((line, i) => line.map((w) => ({ ...w, accent: i === 0, italic: false })));
  const rule = { width: 110, gap: 34 };
  const blockHeight = (n: number, s: number) => Math.round(n * s * LINE_HEIGHT) + rule.gap + 3;
  let height = blockHeight(lines.length, size);
  const TOP = 120;
  const BOTTOM = 150;
  let y: number;
  if (band === 'top') {
    // Above the heads: step the size down, then move up, until it clears them.
    const head = typeof hints.headTopPct === 'number' ? hints.headTopPct : 100;
    const headPx = Math.max(0, Math.min(COVER.height, (head / 83.3) * COVER.height)) - 80;
    y = TOP;
    while (y + height > headPx && size > 64) {
      const next = SIZES[SIZES.indexOf(size) + 1] ?? 64;
      if (next === size) break;
      size = next;
      lines = fitSize(words, TITLE_COLUMN).size >= size ? (wrapWords(words, size) || lines) : lines;
      if (words.length && !words.some((w) => w.accent)) lines = lines.map((line, i) => line.map((w) => ({ ...w, accent: i === 0, italic: false })));
      height = blockHeight(lines.length, size);
    }
    if (y + height > headPx) y = Math.max(60, Math.round(headPx - height));
  } else if (band === 'middle') {
    y = Math.round(COVER.height * 0.46 - height / 2);
  } else {
    y = COVER.height - BOTTOM - height;
  }
  const x = side === 'left' ? TITLE_MARGIN : COVER.width - TITLE_MARGIN - TITLE_COLUMN;
  return { lines, size, x, y, width: TITLE_COLUMN, height, side, band, rule };
}

// --- kept for callers of the earlier, centred cover ------------------------

/** Small connecting words, as the first covers set them. */
const CONNECTORS = new Set(['of', 'and', 'for', 'with', 'in', 'to', 'at', 'on', 'vs.', 'not', 'over', '&']);
export function isConnector(word: string, index: number): boolean {
  return index > 0 && CONNECTORS.has(word.toLowerCase());
}

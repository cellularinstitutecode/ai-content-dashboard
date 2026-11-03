// web/lib/title-cover-layout.ts
// The decisions behind a title cover — the feed's own way with titles — as
// pure functions, so the look can be unit-tested without rendering a pixel.
// lib/title-cover.ts paints.
//
// THE BASELINE IS THE CLINIC'S INSTAGRAM. Its photo posts carry a short
// sentence in large serif type — "Meet Our Team", "Decoding Your Health
// Data", "The Science of Consistent *Sleep*" — set CENTRED, in the clear
// band of the photograph: ABOVE the people when the frame has room over
// their heads, otherwise at the BOTTOM, where a soft darkening carries the
// words. The words that carry the line are in the brand's rust, in italic;
// the rest in the dark brown on a light wall, in cream on the darkened
// bottom; a short rule beneath. Never across a face, never behind a wash.
//
// The earlier rule — a column "beside the subject" on the side a vision
// check called quiet — put the words on the people in four covers out of
// four, behind a cream wash of fading columns the clinic called a white
// hue. Both are gone: the side hint is still accepted and ignored.
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
  /** Centred across the frame, or kept to the quiet side of the band, aligned to it. */
  align: 'center' | 'left' | 'right';
  /** The ink the band calls for: dark brown on the light top of a picture, cream on the darkened bottom. */
  tone: 'ink' | 'cream';
  /** The short rule under the block: its width and the gap above it, px. */
  rule: { width: number; gap: number };
};

/** The ink: the brand's darkest warm brown, softened a touch for a light wall. */
export const TITLE_INK = '#2E2620';
/** The accent: the brand's rust, for the words that carry the line. */
export const TITLE_ACCENT = '#9F4D27';
/** The ink on the darkened bottom band: the feed's cream. */
export const TITLE_CREAM = '#F6F1EA';
/** The accent on the darkened bottom band: the rust, lifted so it reads on dark. */
export const TITLE_ACCENT_ON_DARK = '#D4845A';

/** The side margin the block keeps from the edge. */
export const TITLE_MARGIN = 72;
/** The column the title wraps in: the frame less its margins, the lines centred in it. */
export const TITLE_COLUMN = COVER.width - 2 * TITLE_MARGIN;
/**
 * The highest head must start at least this far down the photograph for the
 * title to go above it. High on purpose: the vision check that measures it
 * has called a head at a fifth of the way down "50", and a title set above a
 * head that is not there lands on a face. Below this the bottom band is used,
 * where faces rarely are.
 */
export const TOP_BAND_MIN_HEAD_PCT = 55;
/** Sizes tried, largest first; the first that wraps into few enough lines and under MAX_BLOCK wins. */
const SIZES = [132, 120, 110, 100, 92, 84, 76, 70, 64];
/**
 * Two lines when they can be had, as the feed's titles are ("Meet Our Team",
 * "Decoding Your Health Data"); three, then four, only when no size wraps
 * shorter. A compact block is what keeps the words off the people.
 */
const LINE_BUDGETS = [2, 3, 4];
/** The block never takes more than this much of the frame's height: the picture stays the picture. */
const MAX_BLOCK = Math.round(COVER.height * 0.3);
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

/** The largest size whose wrap fits the column in the fewest lines possible (two, then three, then four) under MAX_BLOCK tall. */
export function fitSize(words: readonly TitleWord[], width = TITLE_COLUMN): { size: number; lines: TitleWord[][] } {
  for (const budget of LINE_BUDGETS) {
    for (const size of SIZES) {
      const lines = wrapWords(words, size, width);
      if (lines && lines.length <= budget && lines.length * size * LINE_HEIGHT <= MAX_BLOCK) return { size, lines };
    }
  }
  const size = SIZES[SIZES.length - 1];
  return { size, lines: wrapWords(words, size, width) || [words.slice()] };
}

export type LayoutHints = {
  /** Where the highest head starts, as a percentage of the photograph's height (vision check). */
  headTopPct?: number | null;
  /** Accepted for the callers that still pass it; no longer used — the side placement put words on people. */
  clearSide?: Side | null;
  /** The band the picture itself is quiet in (lib/cover-bands.ts quietBand), when one clearly is. */
  quiet?: 'top' | 'bottom' | null;
  /** Within the chosen band, the half without the person (lib/cover-bands.ts quietSide), when one clearly is. */
  quietSide?: Side | null;
};

/** The column when the block keeps to one side of the band: a little under two thirds of the frame. */
export const SIDE_COLUMN = Math.round(COVER.width * 0.62) - TITLE_MARGIN;

/** With the picture's quiet band known, a head this far down is enough room for the title above it. */
export const TOP_BAND_MIN_HEAD_PCT_WHEN_QUIET = 30;

/**
 * Where the block goes.
 *
 *   plenty of room above the heads      → the top band, centred (the feed's
 *                                         "Meet Our Team", "Decoding Your
 *                                         Health Data").
 *   some room, and the top is the quiet → the top band: a plain ceiling over
 *   band of the picture                   a team standing in the lower half.
 *   otherwise                           → the bottom band, centred, on a soft
 *                                         darkening (the feed's "The Science
 *                                         of Consistent Sleep").
 *
 * No head measured means no room can be assumed: the bottom. `headTopPct` is
 * measured on the photograph; the cover shows its top 83.3% (a 2:3 photo
 * cropped to 4:5 from the top), so it is converted where the block is set.
 */
export function placeTitle(hints: LayoutHints): { side: Side; band: Band } {
  const head = typeof hints.headTopPct === 'number' && Number.isFinite(hints.headTopPct) ? hints.headTopPct : null;
  if (head != null && head >= TOP_BAND_MIN_HEAD_PCT) return { side: 'left', band: 'top' };
  if (head != null && head >= TOP_BAND_MIN_HEAD_PCT_WHEN_QUIET && hints.quiet === 'top') return { side: 'left', band: 'top' };
  return { side: 'left', band: 'bottom' };
}

/** The whole layout for a title on a cover. */
export function layoutTitle(title: string, hints: LayoutHints = {}): TitleLayout {
  const words = parseEmphasis(title);
  const { band } = placeTitle(hints);
  // A person standing on one side of the band: the block keeps to the other,
  // in a narrower column, aligned to that edge (the feed's "if regenerative
  // medicine is already on your radar", bottom-left of a desk).
  const align: TitleLayout['align'] = hints.quietSide === 'left' || hints.quietSide === 'right' ? hints.quietSide : 'center';
  const side: Side = align === 'right' ? 'right' : 'left';
  const column = align === 'center' ? TITLE_COLUMN : SIDE_COLUMN;
  let { size, lines } = fitSize(words, column);
  // No markers: the opening line carries the sentence.
  if (words.length && !words.some((w) => w.accent)) lines = lines.map((line, i) => line.map((w) => ({ ...w, accent: i === 0, italic: false })));
  const rule = { width: 110, gap: 34 };
  const blockHeight = (n: number, s: number) => Math.round(n * s * LINE_HEIGHT) + rule.gap + 3;
  let height = blockHeight(lines.length, size);
  const TOP = 110;
  const BOTTOM = 110;
  let y: number;
  if (band === 'top') {
    // Above the heads: step the size down, then move up, until it clears them
    // — and never below a third of the frame, whatever the check measured.
    const head = typeof hints.headTopPct === 'number' ? hints.headTopPct : 100;
    const headPx = Math.min(Math.max(0, Math.min(COVER.height, (head / 83.3) * COVER.height)) - 60, Math.round(COVER.height * 0.36));
    y = TOP;
    while (y + height > headPx && size > 64) {
      const next = SIZES[SIZES.indexOf(size) + 1] ?? 64;
      if (next === size) break;
      size = next;
      lines = fitSize(words, column).size >= size ? (wrapWords(words, size, column) || lines) : lines;
      if (words.length && !words.some((w) => w.accent)) lines = lines.map((line, i) => line.map((w) => ({ ...w, accent: i === 0, italic: false })));
      height = blockHeight(lines.length, size);
    }
    if (y + height > headPx) y = Math.max(60, Math.round(headPx - height));
  } else {
    y = COVER.height - BOTTOM - height;
  }
  const x = align === 'right' ? COVER.width - TITLE_MARGIN - column : TITLE_MARGIN;
  return { lines, size, x, y, width: column, height, side, band, align, tone: band === 'bottom' ? 'cream' : 'ink', rule };
}

// --- kept for callers of the earlier, centred cover ------------------------

/** Small connecting words, as the first covers set them. */
const CONNECTORS = new Set(['of', 'and', 'for', 'with', 'in', 'to', 'at', 'on', 'vs.', 'not', 'over', '&']);
export function isConnector(word: string, index: number): boolean {
  return index > 0 && CONNECTORS.has(word.toLowerCase());
}

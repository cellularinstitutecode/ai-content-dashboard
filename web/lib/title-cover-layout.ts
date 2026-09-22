// web/lib/title-cover-layout.ts
// The decisions behind a title cover — how a title breaks into lines, how big
// it is set, which small words go italic — as pure functions, so the look can
// be unit-tested without rendering a pixel. lib/title-cover.ts paints.
//
// The reference the clinic chose sets "The Importance / of Nutrition" in two
// centred lines of a light, high-contrast serif, the connector "of" in italic,
// with a short hairline under it. That is what these rules reproduce.
//
// Pure: no imports.

export const COVER = { width: 1080, height: 1350 } as const;

/** Small connecting words set in italic, as "of" is in the reference. Never the first word. */
const CONNECTORS = new Set(['of', 'and', 'for', 'with', 'in', 'to', 'at', 'on', 'vs.', 'not', 'over', '&']);

export function isConnector(word: string, index: number): boolean {
  return index > 0 && CONNECTORS.has(word.toLowerCase());
}

/**
 * Break a title into 1-3 balanced lines.
 *
 * Balanced, not greedy: "The Importance of Nutrition" becomes
 * "The Importance / of Nutrition", not "The Importance of / Nutrition". Among
 * equally balanced breaks, the one that starts a line with a connector wins —
 * that is how the reference reads.
 */
export function splitTitleLines(title: string): string[] {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const text = words.join(' ');
  if (text.length <= 18 || words.length === 1) return [text];
  const join = (ws: string[]) => ws.join(' ');
  let best2: { lines: string[]; score: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = join(words.slice(0, i));
    const b = join(words.slice(i));
    const score = Math.max(a.length, b.length) - (isConnector(words[i], i) ? 4 : 0);
    if (!best2 || score < best2.score) best2 = { lines: [a, b], score };
  }
  const longest2 = Math.max(...best2!.lines.map((l) => l.length));
  if (longest2 <= 24 || words.length < 3) return best2!.lines;
  let best3: { lines: string[]; score: number } | null = null;
  for (let i = 1; i < words.length - 1; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const lines = [join(words.slice(0, i)), join(words.slice(i, j)), join(words.slice(j))];
      const score = Math.max(...lines.map((l) => l.length)) - (isConnector(words[i], i) ? 1 : 0) - (isConnector(words[j], j) ? 1 : 0);
      if (!best3 || score < best3.score) best3 = { lines, score };
    }
  }
  return best3!.lines;
}

/** Font size from the longest line, tuned for the 1080-wide cover. */
export function titleFontSize(lines: string[]): number {
  const n = Math.max(0, ...lines.map((l) => l.length));
  return n <= 12 ? 104 : n <= 16 ? 94 : n <= 20 ? 84 : n <= 24 ? 74 : 64;
}

/** The ink: the brand's darkest warm brown, softened a touch for a light wall. */
export const TITLE_INK = '#2E2620';
/** The light wash behind the title, so it reads on any wall the photograph gives us. */
export const TITLE_WASH = 'linear-gradient(180deg, rgba(247,242,235,0.66) 0%, rgba(247,242,235,0.34) 50%, rgba(247,242,235,0) 100%)';

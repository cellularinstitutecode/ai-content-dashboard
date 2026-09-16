// web/lib/video-format.ts
// What the sheet's FORMATO cell says about a video's shape — in one place.
//
// Two rules read that cell with two different regexes: youtubeTypeFor needed
// an explicit "vertical" to upload a Short, fitsAspect refused TikTok only on
// an explicit "horizontal". The clinic writes "Vertical 9:16" and
// "Horizontal 16:9", plus the odd "Reel", "Short", "Cuadrado". One reader,
// two consumers. No imports, so the test runner runs this file directly.

/** "Vertical 9:16", "vertical", "9x16", "reel", "short", "story" → true. */
export function isVerticalFormat(format: string | null | undefined): boolean {
  const f = String(format || '').toLowerCase();
  if (!f) return false;
  return /\bshorts?\b|\breels?\b|\bstor(y|ies)\b|vertical|portrait|retrato|9\s*[:x/]\s*16/.test(f);
}

/** "Horizontal 16:9", "landscape", "paisaje", "16x9" → true. */
export function isLandscapeFormat(format: string | null | undefined): boolean {
  const f = String(format || '').toLowerCase();
  if (!f) return false;
  return /horizontal|landscape|paisaje|16\s*[:x/]\s*9/.test(f);
}

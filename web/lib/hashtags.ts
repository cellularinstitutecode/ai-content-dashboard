// web/lib/hashtags.ts
// The KEYWORDS cell's hashtags, built from the keyword brief.
//
// The sheet shows both shapes today: most rows hold plain search terms
// ("floating bed frame, windbed, hanging bed"), and the row the team pointed at
// holds hashtags instead (#cellularinstitute, #redlighttherapy, …). The cell is
// used for both jobs — the SEO terms the copy was written against, and the tags
// a person pastes when posting — so it now carries the terms AND the tags
// rather than one team's half of it.
//
// Pure, so every rule here is unit-tested without a network.

/** Always first, because it is the clinic's own tag and never comes from Semrush. */
export const HOUSE_HASHTAG = '#cellularinstitute';

/** More than this and a caption reads as tag spam rather than as a post. */
export const MAX_HASHTAGS = 10;

/**
 * One phrase as one hashtag, or '' when it cannot be one.
 *
 * Accents are folded rather than stripped — "cirugía" must become #cirugia and
 * not #cirug. Spanish keyword briefs are half the sheet, so losing the tail of
 * every accented word would quietly mangle most of them.
 */
export function hashtagFrom(phrase: string | null | undefined): string {
  const folded = String(phrase || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Keep letters and digits; everything else is a word boundary that closes up.
    .replace(/[^a-z0-9]+/g, '');
  // One or two characters is noise ("#a"), and a run over thirty is a sentence
  // somebody pasted into the wrong cell.
  if (folded.length < 3 || folded.length > 30) return '';
  // A tag cannot start with a digit on most networks.
  if (/^[0-9]/.test(folded)) return '';
  return '#' + folded;
}

/**
 * The hashtag block for a row, house tag first.
 *
 * Deduplicated on the FOLDED form, so "Red Light Therapy" and "red light
 * therapy" — which Semrush happily returns as two separate keywords — do not
 * become the same tag twice.
 */
export function hashtagsFrom(
  terms: readonly (string | null | undefined)[],
  opts: { house?: string; max?: number } = {},
): string[] {
  const house = opts.house === undefined ? HOUSE_HASHTAG : opts.house;
  const max = opts.max ?? MAX_HASHTAGS;
  const seen = new Set<string>();
  const out: string[] = [];
  if (house) { out.push(house); seen.add(house.toLowerCase()); }
  for (const t of terms || []) {
    const tag = hashtagFrom(t);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

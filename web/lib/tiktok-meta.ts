// web/lib/tiktok-meta.ts
// Metricool's `tiktokData` object for a post going to TikTok.
//
// Without it a TikTok draft has no privacy setting and no interaction
// settings, and Metricool falls back to its "send it to my phone and finish
// there" mode. With it the post is a direct publication: public, with
// comments, duet and stitch allowed, exactly as a person would tick in
// Metricool's editor.
//
// FIELD NAMES. Metricool's own API documentation is not reachable from the
// environment this was written in; the names below are the ones three
// independent public clients of `/v2/scheduler/posts` send and get accepted
// (privacyOption, disableComment, disableDuet, disableStitch,
// commercialContentOwnBrand, commercialContentThirdParty, title). If
// Metricool answers 400 naming `tiktokData`, lib/metricool.ts sends the post
// again without the block and says so, so a wrong name costs a preset, never
// a post.
//
// No imports, so the test runner runs this file directly.

export type TiktokPrivacy = 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';

export type TiktokData = {
  privacyOption: TiktokPrivacy;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  /** "This is my own brand's promotion" — a disclosure TikTok shows on the post. */
  commercialContentOwnBrand: boolean;
  /** "Paid partnership" disclosure. Never true for the clinic's own reels. */
  commercialContentThirdParty: boolean;
  title?: string;
};

export const TIKTOK_TITLE_MAX = 150;

/** The first line of the caption, cleaned, as TikTok's title. */
export function tiktokTitleFrom(title: string | null | undefined, body?: string | null): string {
  const firstLine = String(body || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const raw = String(title || '').trim() || firstLine;
  const clean = raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= TIKTOK_TITLE_MAX) return clean;
  const cut = clean.slice(0, TIKTOK_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > TIKTOK_TITLE_MAX - 30 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The preset: public, comments/duet/stitch on, no paid-partnership flag.
 * `TIKTOK_COMMERCIAL_OWN_BRAND=on` adds TikTok's own-brand disclosure —
 * a policy choice for a person, off by default.
 */
export function tiktokDataFor(
  input: { title?: string | null; body?: string | null },
  env: Record<string, string | undefined> = process.env,
): TiktokData {
  const ownBrand = /^(on|true|1|yes)$/i.test(String(env.TIKTOK_COMMERCIAL_OWN_BRAND || '').trim());
  const title = tiktokTitleFrom(input.title, input.body);
  return {
    privacyOption: 'PUBLIC_TO_EVERYONE',
    disableComment: false,
    disableDuet: false,
    disableStitch: false,
    commercialContentOwnBrand: ownBrand,
    commercialContentThirdParty: false,
    ...(title ? { title } : {}),
  };
}

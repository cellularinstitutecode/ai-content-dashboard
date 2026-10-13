// web/lib/instagram-meta.ts
// Metricool's `instagramData` object for a post going to Instagram.
//
// Without it Metricool submits a video to Instagram as a feed VIDEO, and
// Meta refuses: "The VIDEO value for media_type is deprecated. Use the REELS
// media type to publish a video to your Instagram feed" — the exact words
// Metricool relayed on a post that never went out. A video on Instagram is
// a Reel now, full stop; a picture is a post.
//
// FIELD NAMES come from Metricool's own MCP server (mcp-metricool,
// tools/schedule_post): `instagramData: { type: "POST" | "REEL" | "STORY",
// showReelOnFeed: boolean, … }`. Pure, so the runner reads it directly.
import { looksLikeVideoUrl } from './metricool-normalize-parse.ts';

export type InstagramType = 'POST' | 'REEL' | 'STORY';

export type InstagramData = {
  type: InstagramType;
  /** A Reel also appears on the profile grid, as the feed's own reels do. */
  showReelOnFeed?: boolean;
};

/** Does this media make the Instagram post a Reel? A video does; a picture is a post. */
export function instagramDataFor(input: { hasVideo: boolean }): InstagramData {
  return input.hasVideo ? { type: 'REEL', showReelOnFeed: true } : { type: 'POST' };
}

/** Does any of these media addresses name a video file? */
export function anyVideo(urls: readonly (string | null | undefined)[]): boolean {
  return urls.some((u) => looksLikeVideoUrl(String(u || '')));
}

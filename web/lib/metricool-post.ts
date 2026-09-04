// web/lib/metricool-post.ts
// The shape of a Metricool post as this app writes it — pure, no HTTP, no
// environment, so the rules can be unit-tested:
//
//   * which queue a post lands in (review vs live) is a single explicit mode;
//   * a REPLACE always carries text, networks, date AND media, because
//     Metricool's PUT replaces the whole post and a body without the image
//     silently drops it.
import { formatForMetricool, SCHEDULE_TZ } from './timezone.ts';

export type Provider =
  | 'instagram' | 'facebook' | 'twitter' | 'linkedin'
  | 'tiktok' | 'youtube' | 'gmb' | 'pinterest' | 'threads'
  | 'bluesky';

/**
 * Where a newly created post lands in Metricool.
 *
 *   review     the review queue (draft:true, autoPublish:false) — the default
 *              and the only outcome any automated path may produce.
 *   scheduled  the live queue (draft:false, autoPublish:true) — Metricool will
 *              publish it at publicationDate. Reserved for a person who has
 *              just pressed an explicit Approve in the dashboard.
 */
export type PostMode = 'review' | 'scheduled';

export function modeFlags(mode: PostMode): { draft: boolean; autoPublish: boolean } {
  return mode === 'scheduled' ? { draft: false, autoPublish: true } : { draft: true, autoPublish: false };
}


function wallClockOf(publicationDate: string): string {
  const at = new Date(publicationDate);
  return isNaN(at.getTime()) ? String(publicationDate) : formatForMetricool(at, SCHEDULE_TZ);
}

export type ReplacePostInput = {
  text: string;
  providers: Provider[];
  publicationDate: string;
  /** Attached media. Omitting it on a REPLACE drops the image from the post. */
  media?: { url: string }[];
  mode: PostMode;
};

/** The exact body a replace sends — exported so the rule is unit-testable. */
export function replacePostBody(post: ReplacePostInput) {
  const text = String(post.text || '').trim();
  const providers = Array.isArray(post.providers) ? post.providers.filter(Boolean) : [];
  if (!text || providers.length === 0) {
    // Fail here rather than let Metricool reject it: an empty replace would be
    // a destructive edit if it ever succeeded.
    throw new Error('Metricool update needs the post text and at least one network');
  }
  return {
    text,
    providers: providers.map((network) => ({ network })),
    publicationDate: { dateTime: wallClockOf(post.publicationDate), timezone: SCHEDULE_TZ },
    media: Array.isArray(post.media) ? post.media.filter((m) => m && m.url) : [],
    ...modeFlags(post.mode),
  };
}


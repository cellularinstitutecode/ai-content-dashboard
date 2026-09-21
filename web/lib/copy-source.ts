// web/lib/copy-source.ts
// Where the copy Metricool fetches should come from — and why the answer
// changed under everyone's feet on 15 September.
//
// WHY ROWS 180 AND 182 WENT THROUGH AND NOTHING SINCE HAS.
//
// Three changes landed that afternoon, hours apart:
//
//   #249 17:11  the video is staged in a Supabase bucket and Metricool is
//               handed a public supabase.co URL.       <- 180 and 182 went out
//   #252 17:48  the bucket is created even on a 50 MB project.
//   #253 19:04  when staging fails because the file is over that 50 MB cap,
//               Metricool is handed THIS APP'S OWN streaming URL instead.
//
// And the app runs on Vercel, where a function streams its response through AWS
// Lambda — which caps response streaming far below the size of one reel. So the
// URL minted after #253 can serve a browser, which asks for small ranges and
// plays the first chunks, and cannot serve Metricool, which pulls the whole
// file. Every video since has been handed a link that could not deliver it.
//
// The streaming route says so itself, in a comment written while it was built:
// "Vercel's ceiling, and the reason the minted URL should not point at
// Vercel… PUBLIC_MEDIA_BASE_URL should name that host." Nothing enforced it,
// and the health check that warned about it was softened in #254 because the
// claim was unverified at the time. It is verified now.
//
// So the source is chosen by SIZE, preferring the paths that are proven.
//
// AND THE REFUSAL NAMES ALL THREE WAYS OUT, which it did not. It offered the
// Dokploy host and a re-export, and never mentioned raising the Supabase cap —
// the route rows 180 and 182 actually went out on, and the only one already
// proven from this deployment. It also said "the 50 MB storage limit" as though
// that number were a fact about the world; it is the FREE PLAN's fixed limit,
// and lib/video-bucket-key.ts has carried SUPABASE_UPLOAD_MAX_BYTES for exactly
// this since it was written. A diagnostic that omits the fix somebody can
// actually apply sends them to buy a container they may not need.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { bucketUploadMaxBytes } from './video-bucket-key.ts';

/**
 * Above this, a Drive download link answers with Google's "cannot scan this
 * file for viruses" page instead of the file — which Metricool stored as the
 * video, and which is the failure the bucket was introduced to end.
 */
export const DRIVE_DIRECT_MAX_BYTES = 100 * 1024 * 1024;

export type CopySource = 'bucket' | 'drive' | 'stream';

export type CopyRoute =
  | { source: CopySource }
  | { source: 'refuse'; message: string };

/**
 * Can this host stream a whole reel, or is it a serverless function?
 *
 * An explicitly configured PUBLIC_MEDIA_BASE_URL is trusted: somebody chose
 * that host for this job, and it is the documented way to name the long-lived
 * container. Everything else is checked against Vercel — by hostname, and by
 * the variables its runtime sets, because a custom domain in front of a Vercel
 * deployment has no outward sign at all.
 */
export function servesWholeVideos(base: string, env: Record<string, string | undefined> = process.env): boolean {
  const hostOf = (v: string) => {
    const s = String(v || '').trim();
    if (!s) return '';
    try { return new URL(s).host.toLowerCase(); } catch { return s.toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; }
  };
  const host = hostOf(base);
  if (!host) return false;
  const chosen = hostOf(String(env.PUBLIC_MEDIA_BASE_URL || ''));
  if (chosen && chosen === host) return true;
  if (host.endsWith('.vercel.app')) return false;
  const vercelHost = hostOf(String(env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || ''));
  if (vercelHost && vercelHost === host) return false;
  return true;
}

/** How big it is, as a person reads it. */
function mb(bytes: number): string {
  return Math.round(bytes / 1024 / 1024) + ' MB';
}

/**
 * The source for a video of this size.
 *
 * `staged` is whether the Supabase upload succeeded; when it did, there is
 * nothing to decide — that is the path rows 180 and 182 used. Everything else
 * prefers a proven route and refuses, out loud, to use the one that has never
 * worked from this host.
 */
export function copyRouteFor(input: {
  staged: boolean;
  sizeBytes: number | null | undefined;
  /** The origin a streamed URL would be minted against. */
  base: string;
  env?: Record<string, string | undefined>;
  /**
   * The Supabase upload cap this project actually has, for the refusal to quote
   * honestly. Defaults to the configured one; passed in only by tests, which
   * must not depend on the ambient environment.
   */
  uploadMaxBytes?: number;
}): CopyRoute {
  if (input.staged) return { source: 'bucket' };
  const size = Number(input.sizeBytes);
  const known = Number.isFinite(size) && size > 0;
  // Under Google's scan threshold a Drive copy serves the file itself. It is
  // the oldest path here and it works; it was demoted to a rescue in #253 for
  // a problem that only exists ABOVE this size.
  if (known && size <= DRIVE_DIRECT_MAX_BYTES) return { source: 'drive' };
  if (servesWholeVideos(input.base, input.env)) return { source: 'stream' };
  const cap = Number.isFinite(Number(input.uploadMaxBytes)) && Number(input.uploadMaxBytes) > 0
    ? Number(input.uploadMaxBytes)
    : bucketUploadMaxBytes();
  return {
    source: 'refuse',
    message:
      'This video is ' + (known ? mb(size) : 'too large') + ' — past the ' + mb(cap) + ' Supabase upload limit and past ' +
      'the 100 MB above which Google answers a Drive link with its virus-scan page instead of the file. That leaves ' +
      'streaming it from this app, and these links are built from a Vercel function, which cannot hand a whole video ' +
      'to Metricool: it is why every video since 15 September has been refused while rows 180 and 182 went out. ' +
      'THREE WAYS OUT, none of them done yet. (1) Raise the Supabase upload limit past ' +
      (known ? mb(size) : 'this size') + ' under Storage → Settings and set SUPABASE_UPLOAD_MAX_BYTES to match — this ' +
      'is the bucket route rows 180 and 182 used, the only one already proven here, and the limit is fixed at 50 MB ' +
      'on the free plan so it needs a paid one. (2) Point PUBLIC_MEDIA_BASE_URL at a host that can stream a whole ' +
      'file (the Dokploy copy — see deploy/DOKPLOY.md); this is the one that also survives the 1 GB reels, which no ' +
      'serverless function will ever carry to Supabase and back. (3) Export this reel under 100 MB.',
  };
}

/**
 * Should a copy we already made be used again?
 *
 * A streamed copy minted against a host that cannot serve it is not a copy: it
 * is a link that will be refused exactly as it was last time. Rows prepared
 * between #253 and this change all hold one, so without this they would keep
 * failing forever — the cache would hand back the broken link every time.
 */
export function cachedCopyUsable(
  copyId: string,
  base: string,
  env?: Record<string, string | undefined>,
  /** The cached copy's URL, which is the only way to tell one Drive copy from another. */
  url?: string | null,
): boolean {
  // A LARGE-FILE DRIVE COPY IS NOT USABLE, WHATEVER THE HOST. On 21 September a
  // reel over 100 MB was copied inside Drive and handed over at Google's own
  // confirm=t address; the bytes verified, the preview played, and Metricool
  // stored the link as given with no thumbnail and no video. Metricool copies
  // media only from a plain .mp4 on a plain host. So a cached copy of that
  // shape is a link that will be refused exactly as it was — and, worse, it
  // stood in front of the stream route: once a row held one, this function
  // said "usable" and PUBLIC_MEDIA_BASE_URL was never consulted for it.
  if (isDriveConfirmUrl(url)) return false;
  const streamed = String(copyId || '').startsWith('stream:');
  return streamed ? servesWholeVideos(base, env) : true;
}

/** The confirm=t download address: what the last-chance Drive copy was handed over as. */
export function isDriveConfirmUrl(url: string | null | undefined): boolean {
  return /^https:\/\/drive\.usercontent\.google\.com\/download\?[^#]*\bconfirm=t\b/i.test(String(url || ''));
}

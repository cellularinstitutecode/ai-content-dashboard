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
// Pure: no imports, so the test runner reads this file directly.

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
}): CopyRoute {
  if (input.staged) return { source: 'bucket' };
  const size = Number(input.sizeBytes);
  const known = Number.isFinite(size) && size > 0;
  // Under Google's scan threshold a Drive copy serves the file itself. It is
  // the oldest path here and it works; it was demoted to a rescue in #253 for
  // a problem that only exists ABOVE this size.
  if (known && size <= DRIVE_DIRECT_MAX_BYTES) return { source: 'drive' };
  if (servesWholeVideos(input.base, input.env)) return { source: 'stream' };
  return {
    source: 'refuse',
    message:
      'This video is ' + (known ? mb(size) : 'too large') + ' — past the 50 MB storage limit and past the size Google will ' +
      'serve a link for, so it has to be streamed from this app. The address these links are built from is a Vercel ' +
      'function, which cannot deliver a whole video to Metricool: it is why every video since 15 September has been ' +
      'refused while rows 180 and 182 went out. Set PUBLIC_MEDIA_BASE_URL to a host that can stream it (the Dokploy ' +
      'copy — see deploy/DOKPLOY.md), or export this reel under 100 MB.',
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
export function cachedCopyUsable(copyId: string, base: string, env?: Record<string, string | undefined>): boolean {
  const streamed = String(copyId || '').startsWith('stream:');
  return streamed ? servesWholeVideos(base, env) : true;
}

// web/lib/metricool-normalize-parse.ts
// Reading Metricool's answer to "here is a video, take it".
//
// WHAT HAPPENED. Metricool answered 200, and this app could not find the media
// reference in the reply — so it refused the post rather than send a URL that
// would be dropped in silence. Correct, and useless: a 477 MB file that had
// already crossed the wire was thrown away because of a key name.
//
// The old reader knew five shapes: a bare string, {url}, {data:{url}},
// {mediaId}, {id}. It looked ONE level into `data` and only when `data` was an
// object — so the single most ordinary REST shape in existence,
// `{"data": "https://…"}`, fell straight through it.
//
// This reads the answer the way a person would: find the URL in it. Any depth,
// any key name, preferring the keys that sound like media over ones that do
// not, and refusing to invent one when there is none — because a wrong URL
// would be posted as the clinic's video.
//
// It also DESCRIBES the shape it could not read, in types rather than values
// ("data:string, status:number"), so an answer nobody anticipated is a
// five-minute fix instead of another round of guessing. Values are never
// echoed: the shape is the diagnosis, the contents are not ours to display.
//
// Pure: no imports, so the test runner reads this file directly.

export type NormalizeParse = {
  /** Metricool's own reference for the file, or null when there is none. */
  url: string | null;
  /** The answer's structure, in types — for the message when url is null. */
  shape: string;
};

/** Keys whose name says "this is where the file went". Checked first. */
const MEDIA_KEY = /(^|_|\b)(url|uri|src|link|file|path|media|image|video|data|result|resource|normalized|normalised|location)s?(_|\b|$)/i;
/**
 * Last-resort keys: an opaque reference rather than a URL.
 *
 * Exactly the two the old reader accepted, and no more. A wider list looked
 * harmless and was not: `token` matched, so a body carrying a credential would
 * have had that credential posted as the clinic's video. Narrow on purpose.
 */
const ID_KEY = /^(mediaid|media_id|id)$/i;

const MAX_DEPTH = 6;
const MAX_NODES = 500;

function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
}

/** One level of `key:type` pairs, for the diagnosis. Never any values. */
export function describeShape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array[' + (value.length ? describeShape(value[0], depth + 1) : '') + ']';
  const t = typeof value;
  if (t !== 'object') return t;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
  if (!entries.length) return '{}';
  if (depth >= 2) return '{…}';
  return '{' + entries.map(([k, v]) => k + ':' + describeShape(v, depth + 1)).join(', ') + '}';
}

/**
 * The media reference in Metricool's answer.
 *
 * `sent` is the URL this app handed over. A reply that merely echoes it back is
 * NOT a normalise — the file never moved — so an echo is only ever used when
 * there is nothing else, and the caller's own unchanged-means-degraded check
 * then catches it. Without this, a reply containing both URLs could return ours
 * and report success for a post with no video.
 */
export function readNormalizedUrl(raw: string, sent = ''): NormalizeParse {
  const text = String(raw || '').trim();
  if (!text) return { url: null, shape: 'empty' };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON. A bare URL, quoted or not, is the one thing worth accepting.
    const bare = text.replace(/^"|"$/g, '').trim();
    return isHttpUrl(bare) ? { url: bare, shape: 'string' } : { url: null, shape: 'text' };
  }

  if (isHttpUrl(data)) return { url: String(data).trim(), shape: 'string' };
  if (typeof data === 'string') return { url: null, shape: 'string' };

  const echo = String(sent || '').trim();
  let preferred: string | null = null;   // a URL under a media-ish key
  let anyUrl: string | null = null;      // a URL anywhere
  let echoed: string | null = null;      // our own URL, handed back
  let opaque: string | null = null;      // an id, when there is no URL at all

  let seen = 0;
  const walk = (node: unknown, key: string, depth: number): void => {
    if (node == null || depth > MAX_DEPTH || seen++ > MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k, depth + 1);
      return;
    }
    if (isHttpUrl(node)) {
      const url = String(node).trim();
      if (echo && url === echo) { echoed = echoed || url; return; }
      if (!preferred && MEDIA_KEY.test(key)) preferred = url;
      if (!anyUrl) anyUrl = url;
      return;
    }
    // An opaque reference. Accepted only when the answer holds no URL at all,
    // because "12345" under `id` is as likely to be a request id as a file.
    if (!opaque && typeof node === 'string' && ID_KEY.test(key)) {
      const v = node.trim();
      // Shaped like an identifier, not like a sentence or a secret.
      if (/^[A-Za-z0-9_.:-]{4,100}$/.test(v)) opaque = v;
    }
  };
  walk(data, '', 0);

  const url = preferred || anyUrl || echoed || opaque || null;
  return { url, shape: url ? describeShape(data) : describeShape(data) };
}


// --- which endpoints to ask, which is a decision about the URL ---------------

/** Does the URL name a video file? */
export function looksLikeVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(String(url || ''));
}

/** Does it name a still image? */
export function looksLikeImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(String(url || ''));
}

/**
 * Should the VIDEO endpoints be tried, and the video budget used?
 *
 * WHY THIS IS NOT JUST looksLikeVideoUrl. That asks for an extension, and a
 * Drive download link has none — not the old `uc?export=download&id=...` and
 * not `drive.usercontent.google.com/download?id=...`. So every Drive video this
 * app has ever handed over was treated as an IMAGE: two image endpoints, a
 * sixty-second budget, and /normalize/video/url never asked at all.
 *
 * A 149 MB reel came back as "image 200 · v2/image 404 · image POST 500 ·
 * v2/image POST 404" with Metricool echoing the link straight back — which
 * reads as a problem with the file, while the same panel said the file was
 * fine. It was right: the file was never the problem.
 *
 * An extensionless URL is UNKNOWN, not an image. Unknown is treated as a video
 * candidate, which costs nothing when it is not one — the image endpoint still
 * leads and the loop stops on the first usable answer — and is the difference
 * between trying and not trying when it is.
 *
 * It lives here rather than in lib/metricool.ts because that module imports
 * through `@/` aliases and the test runner cannot load it, which is exactly how
 * a decision this consequential went eight months without a test.
 */
export function mayBeVideoUrl(url: string): boolean {
  const u = String(url || '');
  if (looksLikeVideoUrl(u)) return true;
  return !looksLikeImageUrl(u);
}

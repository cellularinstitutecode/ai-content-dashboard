// web/lib/wordpress.ts
// Publishing an article to the clinic's WordPress, over the REST API.
//
// No plugin, no XML-RPC, no scraping a login form: WordPress has shipped
// /wp-json/wp/v2 since 4.7, and Application Passwords since 5.6. An
// Application Password is generated per application under Users → Profile, is
// not the account's login password, and can be revoked on its own — which is
// the whole reason to use one.
//
// TWO CALLS, IN ORDER. The hero image is uploaded to /media first, because a
// post carries its featured image by ID and there is no way to hand WordPress
// a URL and have it fetch the file. Then the post itself, with
// `featured_media` set. If the upload fails the article still goes up, without
// a picture, and says so — an article with no hero is worth more than no
// article.
//
// A FAILURE IS A FAILURE. Every other send path in this app refuses to record
// a post that was not actually sent ("the two sides can never disagree"), and
// this one holds the same line: publishArticle returns a reason, never a
// cheerful null, and the caller is expected to leave the run in the queue.
//
// Injectable fetch, and `./x.ts` imports only, so the test runner can load
// this file directly and drive it without a WordPress.
import { redact } from './report.ts';

export type WordPressStatus = 'future' | 'draft' | 'publish' | 'pending' | 'private';

export type WordPressConfig = {
  /** The site root, e.g. https://cellularinstitute.com — no trailing slash, no /wp-json. */
  baseUrl: string;
  user: string;
  appPassword: string;
  /** How an article arrives. `future` schedules it to its slot. */
  status: WordPressStatus;
  /** Category ID, when the clinic files articles under one. */
  category: number | null;
};

const STATUSES: readonly string[] = ['future', 'draft', 'publish', 'pending', 'private'];

/**
 * The picture formats WordPress takes, and the extension each one must carry.
 *
 * Anything else — an HTML error page served with HTTP 200 from an expired
 * signed URL, say — is refused rather than uploaded as a "picture".
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Trim a site URL down to its origin + path, with no trailing slash and no /wp-json tail. */
export function normalizeBaseUrl(raw: string): string {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  value = value.replace(/\/+$/, '');
  // Somebody pasting the API root rather than the site root is the likeliest
  // single mistake here, and it produces a 404 with no explanation.
  value = value.replace(/\/wp-json(\/wp\/v2)?$/i, '');
  return value;
}

/**
 * Read the WordPress settings, or null when the site is not configured.
 *
 * Null is not an error: an account with no WordPress simply has no blog
 * destination, and the caller says so rather than failing. All three of URL,
 * user and password are required — two out of three is a misconfiguration that
 * would otherwise show up as a 401 nobody can explain.
 */
export function wordpressConfig(env: Record<string, string | undefined> = process.env): WordPressConfig | null {
  const baseUrl = normalizeBaseUrl(env.WORDPRESS_BASE_URL || '');
  const user = String(env.WORDPRESS_USER || '').trim();
  const appPassword = String(env.WORDPRESS_APP_PASSWORD || '').trim();
  if (!baseUrl || !user || !appPassword) return null;
  const rawStatus = String(env.WORDPRESS_STATUS || '').trim().toLowerCase();
  const status = (STATUSES.includes(rawStatus) ? rawStatus : 'future') as WordPressStatus;
  const rawCategory = String(env.WORDPRESS_CATEGORY || '').trim();
  const category = /^\d+$/.test(rawCategory) ? Number(rawCategory) : null;
  return { baseUrl, user, appPassword, status, category };
}

/** Is there a WordPress to publish to at all? */
export function wordpressConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return wordpressConfig(env) !== null;
}

/** The REST endpoint for a resource. */
export function apiUrl(baseUrl: string, path: string): string {
  return normalizeBaseUrl(baseUrl) + '/wp-json/wp/v2/' + String(path || '').replace(/^\/+/, '');
}

/** Basic auth, as Application Passwords expect. The spaces WordPress prints in them are not significant. */
export function authHeader(user: string, appPassword: string): string {
  const pair = String(user || '') + ':' + String(appPassword || '').replace(/\s+/g, '');
  return 'Basic ' + Buffer.from(pair, 'utf8').toString('base64');
}

/**
 * The date WordPress wants for a scheduled post: UTC, ISO-8601, no trailing Z.
 *
 * This is `date_gmt` and ONLY `date_gmt`. WordPress reads `date` as the site's
 * LOCAL wall clock and only consults `date_gmt` when `date` is absent — so
 * sending the same UTC string as both (which this did at first) publishes a
 * Cancún article five hours late, and on a UTC+ site can date it into the past,
 * where WordPress turns a scheduled post into an immediate one.
 *
 * A `future` post with no date is rejected by WordPress, so this is not
 * optional on that path.
 */
export function wpDate(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(String(at));
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

export type PublishInput = {
  title: string;
  /** The article body. Plain paragraphs are wrapped; anything with tags is passed through. */
  html: string;
  /** When it should publish. Required for `future`. */
  date?: string | Date | null;
  /** A picture to upload and set as the featured image. */
  featuredImageUrl?: string | null;
  /** Overrides the configured status for this one article. */
  status?: WordPressStatus;
};

export type PublishFailure = {
  ok: false;
  reason: 'not_configured' | 'no_title' | 'no_body' | 'no_date' | 'auth' | 'refused' | 'unreachable' | 'unreadable';
  message: string;
};

export type PublishSuccess = {
  ok: true;
  id: number;
  link: string;
  status: string;
  /** '' when there was no image, or when the upload failed and the article went up without one. */
  featuredImage: string;
  /** Said out loud rather than swallowed, so a hero that did not make it is visible. */
  note: string;
};

export type PublishResult = PublishSuccess | PublishFailure;

type Fetcher = typeof fetch;

export type PublishOptions = {
  config?: WordPressConfig | null;
  fetchImpl?: Fetcher;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

/**
 * Markdown-ish body to HTML: enough for paragraphs and the H2 lines the writer
 * produces (lib/ai.ts asks for "H2/H3 style lines").
 *
 * BLOCK BY BLOCK, not all-or-nothing. The first version returned the whole
 * body untouched the moment it saw a single tag anywhere — so one stray `<p>`
 * from the model, or a `<div>` around an embed, shipped every `## Heading` in
 * the article as literal hashes, and left the AVISO and REF lines buried in
 * whatever the model had written. A block that already carries a tag is left
 * alone; its neighbours are still converted.
 */
export function toHtml(body: string): string {
  const text = String(body || '').trim();
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      // A block that STARTS with a tag is HTML and is passed through whole.
      //
      // Enumerating element names was the first attempt, and it wrapped what it
      // did not recognise: a `</div>` closing an embed two blocks below its
      // opener does not match an opening-tag pattern, so it came out as
      // `<p></div></p>` — invalid, and worse than the all-or-nothing version
      // this replaced, which at least shipped the embed intact. Same for the
      // `<tr>` rows of a table.
      if (/^</.test(block)) return block;
      const heading = /^(#{1,6})\s+(.*)$/.exec(block);
      if (heading) {
        // One hash is an H1 and the article already has a title, so it becomes
        // an H2 like the rest. Six is WordPress's floor.
        const level = Math.min(6, Math.max(2, heading[1].length));
        return '<h' + level + '>' + heading[2].trim() + '</h' + level + '>';
      }
      // A list, which a 900-word clinical article nearly always has and which
      // shipped as literal hyphens before. Ordered or not; every line has to be
      // a list item, so a paragraph that merely opens with a dash is untouched.
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const bullet = lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l));
      const numbered = lines.length > 0 && lines.every((l) => /^\d+[.)]\s+/.test(l));
      if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol';
        const items = lines.map((l) => '<li>' + l.replace(/^([-*•]|\d+[.)])\s+/, '') + '</li>').join('');
        return '<' + tag + '>' + items + '</' + tag + '>';
      }
      return '<p>' + block.replace(/\n/g, '<br />') + '</p>';
    })
    .join('\n');
}

function reason(status: number): PublishFailure['reason'] {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'unreachable';
  return 'refused';
}

async function readMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return 'HTTP ' + res.status;
    try {
      const body = JSON.parse(text) as { message?: string; code?: string };
      if (body?.message) return String(body.message);
      if (body?.code) return String(body.code);
    } catch { /* not JSON — WordPress errors sometimes arrive as HTML */ }
    return text.slice(0, 300);
  } catch {
    return 'HTTP ' + res.status;
  }
}

/**
 * Upload a picture and return its media ID.
 *
 * Returns null rather than throwing: a missing hero must not stop an article.
 */
export async function uploadFeaturedImage(
  imageUrl: string,
  config: WordPressConfig,
  opts: { fetchImpl?: Fetcher; timeoutMs?: number } = {},
): Promise<{ id: number | null; note: string }> {
  const doFetch = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const src = await doFetch(imageUrl, { signal });
    if (!src.ok) return { id: null, note: 'the hero image could not be downloaded (HTTP ' + src.status + ')' };
    // Parameters stripped: `image/jpeg; charset=binary` is a media type the
    // extension table below would not recognise.
    const type = (src.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    const bytes = new Uint8Array(await src.arrayBuffer());
    if (!bytes.length) return { id: null, note: 'the hero image came back empty' };

    // THE EXTENSION HAS TO AGREE WITH THE TYPE. WordPress runs
    // wp_check_filetype_and_ext and refuses a mismatch as a security failure,
    // so naming a webp `.jpg` — which this did — meant every webp hero was
    // silently rejected and every such article went up with no picture.
    const ext = IMAGE_EXTENSIONS[type];
    if (!ext) {
      return { id: null, note: 'the hero image came back as ' + type + ', which WordPress will not accept as a picture' };
    }
    const name = 'hero-' + Date.now() + '.' + ext;
    const res = await doFetch(apiUrl(config.baseUrl, 'media'), {
      method: 'POST',
      headers: {
        Authorization: authHeader(config.user, config.appPassword),
        'Content-Type': type,
        'Content-Disposition': 'attachment; filename="' + name + '"',
      },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { id: null, note: 'WordPress refused the hero image: ' + (await readMessage(res)) };
    const body = (await res.json()) as { id?: number };
    return typeof body?.id === 'number' ? { id: body.id, note: '' } : { id: null, note: 'WordPress accepted the image but returned no id' };
  } catch (err) {
    return { id: null, note: 'the hero image could not be uploaded: ' + redact(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * Publish (or schedule) one article.
 *
 * The article goes up without its picture if the upload fails, and the result
 * says so. Everything else is a refusal with a reason the caller can print.
 */
export async function publishArticle(input: PublishInput, opts: PublishOptions = {}): Promise<PublishResult> {
  const config = opts.config !== undefined ? opts.config : wordpressConfig(opts.env);
  if (!config) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'No WordPress site is configured, so there was nowhere to publish the article. Set WORDPRESS_BASE_URL, WORDPRESS_USER and WORDPRESS_APP_PASSWORD.',
    };
  }

  const title = String(input.title || '').trim();
  if (!title) return { ok: false, reason: 'no_title', message: 'The article has no title, and WordPress needs one.' };

  const html = toHtml(input.html);
  if (!html) return { ok: false, reason: 'no_body', message: 'The article has no body, so nothing was published.' };

  const status = input.status || config.status;
  const date = input.date ? wpDate(input.date) : '';
  // WordPress rejects a `future` post with no date, and reading that rejection
  // back is harder than refusing it here with a sentence that explains itself.
  if (status === 'future' && !date) {
    return {
      ok: false,
      reason: 'no_date',
      message: 'This article is meant to be scheduled, but it has no publishing time.',
    };
  }

  const doFetch = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 45_000;

  let featuredMedia: number | null = null;
  let note = '';
  if (input.featuredImageUrl) {
    const upload = await uploadFeaturedImage(input.featuredImageUrl, config, { fetchImpl: doFetch, timeoutMs });
    featuredMedia = upload.id;
    // The article still goes up. An article with no hero is worth more than no
    // article — but nobody should have to wonder where the picture went.
    if (!upload.id) note = 'Published without a hero image: ' + upload.note + '.';
  }

  const payload: Record<string, unknown> = { title, content: html, status };
  // `date_gmt` alone — see wpDate. Sending `date` too would override it with
  // the same string read as local time.
  if (date) payload.date_gmt = date;
  if (featuredMedia) payload.featured_media = featuredMedia;
  if (config.category) payload.categories = [config.category];

  try {
    const res = await doFetch(apiUrl(config.baseUrl, 'posts'), {
      method: 'POST',
      headers: {
        Authorization: authHeader(config.user, config.appPassword),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const message = await readMessage(res);
      return {
        ok: false,
        reason: reason(res.status),
        message:
          res.status === 401 || res.status === 403
            ? 'WordPress refused the login. Check WORDPRESS_USER and that the Application Password has not been revoked. (' + message + ')'
            : 'WordPress refused the article: ' + message,
      };
    }
    const body = (await res.json()) as { id?: number; link?: string; status?: string };
    if (typeof body?.id !== 'number') {
      return { ok: false, reason: 'unreadable', message: 'WordPress answered, but with no post id — nothing can be recorded against that.' };
    }
    return {
      ok: true,
      id: body.id,
      link: String(body.link || ''),
      status: String(body.status || status),
      featuredImage: featuredMedia ? String(featuredMedia) : '',
      note,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      message: 'WordPress could not be reached: ' + redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

// web/lib/article-promo.ts
// The weekly article goes out first; the posts that promote it carry its link.
//
// WHY. The weekly article was sent to Metricool as three promo posts BEFORE
// WordPress had been asked for the article, and nothing ever put a URL in the
// promo text — so "Read the full article" pointed nowhere, on every network,
// every Monday. And the three promos made fifteen social posts a week where
// the strategy asks for fourteen, one of them an Instagram caption that cannot
// carry a clickable link at all.
//
// So the article is published first, its link is written into the run's log
// before anything else happens (a retry then reuses it instead of publishing a
// second article), and the promos — Facebook and LinkedIn only, where a link
// works — are built around the real URL.
//
// Pure: no imports, so the test runner reads this file directly.

/** What WordPress answered, enough to build a link from. */
export type PublishedArticle = { id: number; link?: string | null; status?: string | null };

/**
 * The URL to promote. WordPress's own permalink when it gave one; otherwise
 * the `?p=<id>` form, which every WordPress site resolves (and which is all a
 * draft has).
 */
export function articleUrl(published: PublishedArticle, baseUrl: string): string {
  const link = String(published.link || '').trim();
  if (/^https?:\/\//i.test(link)) return link;
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  return base ? base + '/?p=' + published.id : '';
}

const COMPLIANCE_LINE = /^[ \t]*(REF(?:ERENCIA)?[ \t]*[.:：]|AVISO\s+DE\s+PUBLICIDAD\b)/i;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const BIO_RE = /\s*\(?\b(link in (our |the )?bio|link below|see link)\b\)?[.!]?/gi;

/**
 * The promo text with the article's link in it, placed above the REF and
 * AVISO lines (which stay last, as the advertising rule's checks expect). Any
 * URL or "link in bio" the writer produced is removed: the writer never knew
 * the real link, so whatever it wrote was a guess or a placeholder.
 */
export function withArticleLink(text: string, url: string): string {
  const lines = String(text || '').replace(/\s+$/, '').split('\n').map((l) => l.replace(URL_RE, '').replace(BIO_RE, '').replace(/[ \t]+$/, ''));
  let cut = lines.findIndex((l) => COMPLIANCE_LINE.test(l));
  if (cut < 0) cut = lines.length;
  const body = lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  const tail = lines.slice(cut).join('\n').replace(/^\s+/, '');
  const linkLine = url ? 'Read the full article: ' + url : '';
  return [body, linkLine, tail].filter(Boolean).join('\n\n');
}

/** The run-log note that records a published article. Short: the log column caps notes. */
export function articleLogNote(published: PublishedArticle, url: string): string {
  return 'Article on WordPress (id ' + published.id + ', ' + String(published.status || 'published') + '): ' + url;
}

/**
 * The article a previous attempt already published, read back from the run's
 * log — so a retry after a promo failure promotes it instead of publishing a
 * second one.
 */
export function readArticleLog(log: readonly { step?: string; note?: string }[] | null | undefined): { id: number; url: string } | null {
  for (const entry of [...(log || [])].reverse()) {
    if (entry?.step !== 'article') continue;
    const m = /id (\d+)[^)]*\):\s*(\S+)/.exec(String(entry.note || ''));
    if (m) return { id: Number(m[1]), url: m[2] };
  }
  return null;
}

/**
 * A link of realistic length, for checking a promo against its network's
 * limit before the real one exists.
 */
export const ARTICLE_LINK_PLACEHOLDER = 'https://www.example-clinic-website.com/2026/09/28/a-long-article-permalink-slug-for-length-checks/';

/** Posted ten minutes after the article, so the link is live when the post is. */
export const PROMO_DELAY_MINUTES = 10;

// web/lib/performance.ts
// Server-only helpers for the performance feedback loop.
//
// Pulls post-level analytics from Metricool, normalizes the fields we can read
// (engagement varies by network and API version), and turns the top performers
// into a short natural-language hint that lib/ai.ts can fold into the prompt.
//
// Everything here is DEFENSIVE: Metricool's analytics payload shape is not
// guaranteed, so we read optional fields, coerce numbers, and degrade to an
// empty result rather than throwing. The generation path treats a missing hint
// as "no signal yet".
import 'server-only';
import { createHash } from 'crypto';

const METRICOOL_BASE = 'https://app.metricool.com/api';

// Metricool sometimes returns analytics rows with no stable id. The post_metrics
// upsert conflict key is (user_id, network, external_id), and in Postgres NULLs
// never conflict — so a null external_id makes every re-sync INSERT the same
// id-less post again, ballooning the table and skewing the "top performers" hint.
// Derive a deterministic synthetic id from the row's stable fields so those rows
// dedupe on re-sync like any other.
function syntheticId(network: string, publishedAt: string | null, text: string | null): string {
  const basis = [network, publishedAt ?? '', (text ?? '').slice(0, 200)].join('|');
  return 'syn:' + createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

export type NormalizedMetric = {
  network: string;
  externalId: string | null;
  text: string | null;
  publishedAt: string | null;
  impressions: number;
  engagement: number;
};

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? Number(n) : 0;
}

// Pull the first present value across a list of candidate keys.
function pick(obj: Record<string, any>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj != null && obj[k] != null) return obj[k];
  }
  return undefined;
}

// Best-effort extraction of an engagement figure from a heterogeneous row.
function engagementOf(row: Record<string, any>): number {
  const direct = pick(row, ['engagement', 'engagements', 'interactions', 'totalInteractions']);
  if (direct != null) return num(direct);
  return (
    num(pick(row, ['likes', 'reactions', 'favorites'])) +
    num(pick(row, ['comments', 'replies'])) +
    num(pick(row, ['shares', 'retweets', 'reposts'])) +
    num(pick(row, ['saves', 'bookmarks']))
  );
}

// Normalize an arbitrary Metricool analytics payload into rows we understand.
export function normalizeMetrics(payload: any): NormalizedMetric[] {
  const list: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.posts)
    ? payload.posts
    : Array.isArray(payload?.results)
    ? payload.results
    : [];

  return list
    .map((row: Record<string, any>) => {
      const network = String(pick(row, ['network', 'provider', 'platform']) ?? 'unknown');
      const text = (pick(row, ['text', 'content', 'message', 'caption']) ?? null) as string | null;
      const publishedAt = (pick(row, ['publicationDate', 'publishedAt', 'date', 'dateTime']) ?? null) as string | null;
      const rawId = pick(row, ['id', 'postId', 'externalId']);
      const externalId = rawId != null && String(rawId).trim()
        ? String(rawId)
        : syntheticId(network, publishedAt, text);
      return {
        network,
        externalId,
        text,
        publishedAt,
        impressions: num(pick(row, ['impressions', 'reach', 'views'])),
        engagement: engagementOf(row),
      };
    })
    .filter((m) => m.engagement > 0 || m.impressions > 0);
}

// Fetch post analytics for the last N days. Returns [] on any failure.
export async function fetchPostMetrics(days = 30): Promise<NormalizedMetric[]> {
  const token = process.env.METRICOOL_USER_TOKEN;
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;
  if (!token || !blogId || !userId) return [];

  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const url = new URL(METRICOOL_BASE + '/v2/analytics/posts');
  url.searchParams.set('blogId', blogId);
  url.searchParams.set('userId', userId);
  url.searchParams.set('start', fmt(start));
  url.searchParams.set('end', fmt(end));

  try {
    const res = await fetch(url.toString(), {
      headers: { 'X-Mc-Auth': token, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const payload = await res.json().catch(() => null);
    return normalizeMetrics(payload);
  } catch {
    return [];
  }
}

// Turn normalized metrics into a short prompt hint. Empty when no signal.
export function summarizeTopPerformers(metrics: NormalizedMetric[], limit = 3): string {
  if (!metrics || metrics.length === 0) return '';
  const ranked = [...metrics].sort((a, b) => b.engagement - a.engagement).slice(0, limit);
  const lines: string[] = [];
  ranked.forEach((m, i) => {
    const snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const net = m.network !== 'unknown' ? m.network : 'a channel';
    const quoted = snippet ? ': "' + snippet + '"' : '';
    lines.push((i + 1) + '. On ' + net + ' (engagement ' + m.engagement + ')' + quoted);
  });
  if (lines.length === 0) return '';
  return (
    'Recent top-performing posts for this brand (learn from what worked; do not copy verbatim):\n' +
    lines.join('\n')
  );
}

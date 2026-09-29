// web/lib/youtube-stats.ts
// The YouTube channel's community numbers — subscribers, video views, revenue,
// videos — as Metricool's own "Community · Growth" panel shows them, for the
// dashboard's main page.
//
// WHERE THEY COME FROM. Metricool serves account-level YouTube figures from its
// older statistics API, one metric per call:
//   GET /api/stats/timeline/{metric}?start=YYYYMMDD&end=YYYYMMDD&timezone=…
// with the metrics yttotalSubscribers, ytsubscribersGained, ytsubscribersLost,
// ytVideos and ytestimatedRevenue; and video views from the v2 timelines:
//   GET /api/v2/analytics/timelines?network=youtube&metric=views&from=…&to=…
// (the same calls Metricool's own MCP server makes). The answers are lists of
// dated values whose exact wrapping differs between the two APIs, so the
// reader below accepts every shape they use rather than trusting one.
//
// Pure: no imports, so the test runner reads this file directly.

export type Point = { date: string; value: number };

/** The account metrics read from /stats/timeline, in the order the tiles show them. */
// Subscribers, and gained/lost for the net change. Videos and revenue
// (ytVideos, ytestimatedRevenue) were dropped from the card at the team's
// request, so they are no longer fetched.
export const YT_ACCOUNT_METRICS = ['yttotalSubscribers', 'ytsubscribersGained', 'ytsubscribersLost'] as const;
export type YtAccountMetric = (typeof YT_ACCOUNT_METRICS)[number] | 'ytVideos' | 'ytestimatedRevenue';

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "20260929", "2026-09-29T00:00:00+02:00", or epoch ms/s → "2026-09-29". */
export function dayOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n < 1e11 ? n * 1000 : n);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  return null;
}

/**
 * The dated values in a Metricool timeline answer, oldest first, one per day.
 *
 * Accepted: `[[date, value], …]`; `[{date|dateTime|day, value}, …]`; either
 * wrapped in `{ data: … }`; and the v2 form `{ data: [{ metric, values: [...] }] }`.
 */
export function parseTimeline(json: unknown): Point[] {
  let body: unknown = json;
  for (let i = 0; i < 3 && body && typeof body === 'object' && !Array.isArray(body); i++) {
    const o = body as Record<string, unknown>;
    body = o.data ?? o.values ?? o.timeline ?? null;
  }
  if (!Array.isArray(body)) return [];
  // v2: [{ metric, values: [...] }] — take the first series.
  if (body.length && body[0] && typeof body[0] === 'object' && !Array.isArray(body[0]) && Array.isArray((body[0] as Record<string, unknown>).values)) {
    body = (body[0] as Record<string, unknown>).values as unknown[];
  }
  const byDay = new Map<string, number>();
  for (const row of body as unknown[]) {
    let date: string | null = null;
    let value: number | null = null;
    if (Array.isArray(row)) {
      date = dayOf(row[0]);
      value = num(row[1]);
    } else if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      date = dayOf(o.date ?? o.dateTime ?? o.day ?? o.time ?? o.timestamp);
      value = num(o.value ?? o.count ?? o.total);
    }
    if (date && value != null) byDay.set(date, value);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

const last = (p: Point[]) => (p.length ? p[p.length - 1].value : null);
const sum = (p: Point[]) => (p.length ? Math.round(p.reduce((n, x) => n + x.value, 0) * 100) / 100 : null);

export type YouTubeStats = {
  /** The channel's subscribers on the last day of the range. */
  subscribers: number | null;
  /** Net change over the range: gained − lost, or the total's own movement. */
  subscribersChange: number | null;
  gained: number | null;
  lost: number | null;
  /** Views over the range. */
  views: number | null;
  /** Estimated revenue over the range. */
  revenue: number | null;
  /** Videos on the channel on the last day of the range. */
  videos: number | null;
  /** Subscribers by day, for the trend. */
  trend: Point[];
};

/** The tiles from the separate timelines. Missing series stay null — never zero. */
export function summarizeYouTube(series: Partial<Record<YtAccountMetric | 'views', Point[]>>): YouTubeStats {
  const subs = series.yttotalSubscribers ?? [];
  const gained = series.ytsubscribersGained?.length ? sum(series.ytsubscribersGained) : null;
  const lost = series.ytsubscribersLost?.length ? sum(series.ytsubscribersLost) : null;
  const moved = subs.length >= 2 ? subs[subs.length - 1].value - subs[0].value : null;
  return {
    subscribers: last(subs),
    subscribersChange: gained != null && lost != null ? gained - lost : moved,
    gained,
    lost,
    views: series.views?.length ? sum(series.views) : null,
    revenue: series.ytestimatedRevenue?.length ? sum(series.ytestimatedRevenue) : null,
    videos: last(series.ytVideos ?? []),
    trend: subs,
  };
}

/** YYYYMMDD for the stats API; YYYY-MM-DD for v2. */
export function rangeFor(days: number, now: Date = new Date()): { start: string; end: string; from: string; to: string } {
  const end = new Date(now);
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start).replace(/-/g, ''), end: iso(end).replace(/-/g, ''), from: iso(start), to: iso(end) };
}

// web/app/api/metricool/youtube/route.ts
// GET → the YouTube channel's community numbers for the last 30 days
// (subscribers, net change, video views, estimated revenue, videos, and the
// subscriber trend), for the dashboard's main page. The same figures as
// Metricool's own Community · Growth panel, read from the same Metricool
// account the rest of the app uses. Reading only; nothing is changed.
//
// Endpoints and metric names are the ones Metricool's own MCP server uses
// (see lib/youtube-stats.ts). Each series is fetched on its own and a failed
// one is left empty, so one Metricool hiccup never blanks the panel.
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { metricoolConfigured, metricoolFetch } from '@/lib/metricool';
import { reportError } from '@/lib/report';
import { SCHEDULE_TZ } from '@/lib/timezone';
import { YT_ACCOUNT_METRICS, parseTimeline, rangeFor, summarizeYouTube, type Point, type YouTubeStats } from '@/lib/youtube-stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAYS = 30;
/** Metricool updates these daily; a reload within this window reuses the last answer. */
const TTL_MS = 15 * 60 * 1000;
let cached: { at: number; body: { stats: YouTubeStats; days: number; missing: string[] } } | null = null;

async function series(path: string): Promise<Point[] | null> {
  try {
    const res = await metricoolFetch(path, { method: 'GET', timeoutMs: 12_000 });
    if (!res.ok) return null;
    return parseTimeline(await res.json().catch(() => null));
  } catch (e) {
    reportError('metricool-youtube:series', e, { path: path.split('?')[0] });
    return null;
  }
}

export async function GET() {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'metricool-read');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }
  if (!metricoolConfigured()) {
    return NextResponse.json({ error: 'not_configured', message: 'Metricool is not connected on this deployment.' }, { status: 503 });
  }
  if (cached && Date.now() - cached.at < TTL_MS) return NextResponse.json(cached.body);

  const r = rangeFor(DAYS);
  const tz = encodeURIComponent(SCHEDULE_TZ);
  const account = YT_ACCOUNT_METRICS.map((metric) =>
    series('/stats/timeline/' + metric + '?start=' + r.start + '&end=' + r.end + '&timezone=' + tz),
  );
  const viewsQuery = new URLSearchParams({
    network: 'youtube',
    metric: 'views',
    from: r.from + 'T00:00:00',
    to: r.to + 'T23:59:59',
    timezone: SCHEDULE_TZ,
  });
  const views = series('/v2/analytics/timelines?' + viewsQuery.toString());
  const [results, viewPoints] = await Promise.all([Promise.all(account), views]);

  const got: Record<string, Point[]> = {};
  const missing: string[] = [];
  YT_ACCOUNT_METRICS.forEach((m, i) => { const p = results[i]; if (p && p.length) got[m] = p; else missing.push(m); });
  if (viewPoints && viewPoints.length) got.views = viewPoints; else missing.push('views');

  if (missing.length === YT_ACCOUNT_METRICS.length + 1) {
    // Nothing at all: say so rather than show a row of zeros.
    return NextResponse.json(
      { error: 'no_data', message: 'Metricool returned no YouTube figures. Check that the YouTube channel is connected to this brand in Metricool.' },
      { status: 502 },
    );
  }
  const body = { stats: summarizeYouTube(got), days: DAYS, missing };
  cached = { at: Date.now(), body };
  return NextResponse.json(body);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { YT_ACCOUNT_METRICS, dayOf, parseTimeline, rangeFor, summarizeYouTube } from './youtube-stats.ts';

test('dates in every form Metricool uses read as one day', () => {
  assert.equal(dayOf('20260929'), '2026-09-29');
  assert.equal(dayOf('2026-09-29T00:00:00+02:00'), '2026-09-29');
  assert.equal(dayOf(Date.parse('2026-09-29T12:00:00Z')), '2026-09-29');
  assert.equal(dayOf(''), null);
});

test('a timeline reads in every shape the two APIs answer with', () => {
  const want = [{ date: '2026-09-27', value: 406 }, { date: '2026-09-28', value: 408 }];
  // /stats/timeline: pairs, newest first, values as strings.
  assert.deepEqual(parseTimeline([['20260928', '408'], ['20260927', '406']]), want);
  // Objects, wrapped.
  assert.deepEqual(parseTimeline({ data: [{ date: '2026-09-27', value: 406 }, { date: '2026-09-28', value: 408 }] }), want);
  // v2: { data: [{ metric, values: [{ dateTime, value }] }] }.
  assert.deepEqual(parseTimeline({ data: [{ metric: 'views', values: [{ dateTime: '2026-09-27T00:00:00+02:00', value: 406 }, { dateTime: '2026-09-28T00:00:00+02:00', value: 408 }] }] }), want);
  assert.deepEqual(parseTimeline(null), []);
  assert.deepEqual(parseTimeline({ error: 'nope' }), []);
});

test('the tiles: latest subscribers and videos, sums for views and revenue, net change', () => {
  const s = summarizeYouTube({
    yttotalSubscribers: [{ date: '2026-08-30', value: 394 }, { date: '2026-09-28', value: 408 }],
    ytsubscribersGained: [{ date: '2026-09-01', value: 10 }, { date: '2026-09-20', value: 6 }],
    ytsubscribersLost: [{ date: '2026-09-10', value: 2 }],
    ytVideos: [{ date: '2026-09-01', value: 20 }, { date: '2026-09-28', value: 24 }],
    ytestimatedRevenue: [{ date: '2026-09-01', value: 0 }],
    views: [{ date: '2026-09-01', value: 5000 }, { date: '2026-09-02', value: 670 }],
  });
  assert.equal(s.subscribers, 408);
  assert.equal(s.subscribersChange, 14, 'gained − lost');
  assert.equal(s.videos, 24);
  assert.equal(s.views, 5670);
  assert.equal(s.revenue, 0, 'a real zero stays zero');
  assert.equal(s.trend.length, 2);
});

test('a series Metricool did not return stays empty, never a made-up zero', () => {
  const s = summarizeYouTube({ yttotalSubscribers: [{ date: '2026-09-01', value: 400 }, { date: '2026-09-28', value: 408 }] });
  assert.equal(s.views, null);
  assert.equal(s.revenue, null);
  assert.equal(s.videos, null);
  assert.equal(s.subscribersChange, 8, 'falls back to the total\'s own movement');
});

test('the range is the stats API\'s YYYYMMDD and v2\'s YYYY-MM-DD', () => {
  const r = rangeFor(30, new Date('2026-09-29T12:00:00Z'));
  assert.deepEqual(r, { start: '20260831', end: '20260929', from: '2026-08-31', to: '2026-09-29' });
});

test('the route asks Metricool for exactly these, as its own MCP server does', () => {
  const route = readFileSync(new URL('../app/api/metricool/youtube/route.ts', import.meta.url), 'utf8');
  assert.match(route, /'\/stats\/timeline\/' \+ metric/);
  assert.match(route, /\/v2\/analytics\/timelines\?/);
  assert.match(route, /network: 'youtube'/);
  assert.match(route, /metric: 'views'/);
  assert.match(route, /checkRateLimit\(auth\.userId, 'metricool-read'\)/);
  assert.equal(YT_ACCOUNT_METRICS.length, 5);
});

test('the main page shows the YouTube card', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{!isDraft && <YouTubeStats \/>\}/);
  const card = readFileSync(new URL('../components/YouTubeStats.tsx', import.meta.url), 'utf8');
  assert.match(card, /fetch\('\/api\/metricool\/youtube'\)/);
  for (const label of ['Subscribers', 'Video views', 'Revenue', 'Videos']) assert.match(card, new RegExp('label="' + label + '"'));
});

// GET /api/videos/ticks
//
// The rows of the video sheet with boxes ticked that are still owed a post,
// for the dashboard's "Prepare checked boxes" panel (components/TickScheduler.tsx).
// The same question the sheet's own panel asks, answered here from the
// dashboard's reading of the sheet and the rows' records, so nothing has to be
// installed in the sheet for a person to pick a day and a time and send.
//
// Reads only. Sending is POST /api/videos/row with `publishAt`, one row at a
// time, which the panel does next.
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { SOURCE_IDS, readVideos } from '@/lib/google-sources';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { tickRows, type TickRun } from '@/lib/tick-rows';
import { SCHEDULE_TZ, wallClockInTz } from '@/lib/timezone';
import { postTimes } from '@/lib/video-slot';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  // A sheet read and a table read, no third party: the read bucket, not the spend one.
  const rl = await checkRateLimit(auth.userId, 'posts-read');
  if (!rl.ok) return NextResponse.json({ ok: false, error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  try {
    const spreadsheetId = SOURCE_IDS.videosSheet();
    const [{ entries }, runs] = await Promise.all([
      readVideos(spreadsheetId),
      supabaseAdmin()
        .from('video_runs')
        .select('tab,row_key,state,metricool,draft_id')
        .eq('spreadsheet_id', spreadsheetId)
        .eq('state', 'prepared')
        .limit(2000)
        .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } })),
    ]);
    if (runs.error) throw new Error('The rows’ records could not be read: ' + (runs.error.message || 'database error'));
    const rows = tickRows(
      entries.map((e) => ({ tab: e.tab, row: e.row, title: e.title, videoLink: e.videoLink, networks: e.networks })),
      (runs.data || []) as TickRun[],
    );
    // When each row's existing posts go out, from the posts table, so a row
    // answered "already has" says Facebook Fri 7 Nov 17:00 rather than only
    // "already has Facebook" — the first question a person asks next.
    const draftIds = Array.from(new Set(rows.map((r) => r.draftId).filter((id): id is string => Boolean(id))));
    const have = new Map<string, { network: string; at: string; status: string }[]>();
    if (draftIds.length) {
      const posts = await supabaseAdmin()
        .from('posts')
        .select('draft_id,providers,publication_date,status')
        .in('draft_id', draftIds)
        .limit(2000)
        .then((x) => x, () => ({ data: null, error: null }));
      for (const p of (posts.data || []) as { draft_id: string; providers: string[] | null; publication_date: string | null; status: string | null }[]) {
        const list = have.get(p.draft_id) || [];
        for (const n of p.providers || []) list.push({ network: String(n).toLowerCase(), at: String(p.publication_date || ''), status: String(p.status || '') });
        have.set(p.draft_id, list);
      }
    }
    const now = new Date();
    const w = wallClockInTz(now, SCHEDULE_TZ);
    const p = (n: number) => String(n).padStart(2, '0');
    return NextResponse.json({
      ok: true,
      // Ready first, newest row first; the rows already done follow so a
      // person sees them answered rather than missing. Old rows where a tick
      // is a record of something published by hand are a count.
      rows: rows
        .filter((r) => r.state !== 'not_prepared')
        .sort((a, b) => (a.state === b.state ? b.row - a.row : a.state === 'ready' ? -1 : 1))
        .map((r) => ({ ...r, have: (r.draftId && have.get(r.draftId)) || [] })),
      notPrepared: rows.filter((r) => r.state === 'not_prepared').length,
      slotTimes: postTimes(),
      timezone: SCHEDULE_TZ,
      today: `${w.y}-${p(w.m)}-${p(w.d)}`,
      now: `${p(w.hh)}:${p(w.mm)}`,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    reportError('videos:ticks', e);
    return NextResponse.json({ ok: false, error: 'unreadable', message: e instanceof Error ? e.message : 'The ticked rows could not be read.' }, { status: 503 });
  }
}

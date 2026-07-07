import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// GET /api/metricool?blogId=4308292
// Probes multiple Metricool endpoints; returns the full upstream body so we can see exactly what's rejected.
export async function GET(req: NextRequest) {
  // --- Auth guard (defense in depth; matches drafts/opus routes) ---
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const token = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID || '3377431';
  if (!token) {
    return NextResponse.json({ error: 'METRICOOL_USER_TOKEN not configured in Vercel env' }, { status: 500 });
  }
  const blogId = req.nextUrl.searchParams.get('blogId') || '4308292';
  const today = new Date();
  const start = new Date(today.getTime() - 30 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const base = 'https://app.metricool.com/api';
  const qs = 'blogId=' + blogId + '&userId=' + userId + '&start=' + fmt(start) + '&end=' + fmt(today);
  const candidates = [
    base + '/v2/analytics/posts?' + qs,
    base + '/v2/analytics/web?' + qs,
    base + '/admin/simpleProfiles?blogId=' + blogId + '&userId=' + userId,
    base + '/stats/web?' + qs,
  ];
  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { 'X-Mc-Auth': token, 'Accept': 'application/json' } });
      const text = await r.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 800) }; }
      attempts.push({ url, status: r.status, ok: r.ok, body });
      if (r.ok) {
        return NextResponse.json({ blogId, userId, range: { start: fmt(start), end: fmt(today) }, endpoint: url, data: body });
      }
    } catch (e: any) {
      attempts.push({ url, error: e && e.message ? e.message : String(e) });
    }
  }
  return NextResponse.json({ error: 'All Metricool endpoints rejected the request', attempts }, { status: 502 });
}

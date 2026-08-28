import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { isAllowedEmail, DEFAULT_BLOG_ID, isAllowedBlogId } from '@/lib/access';

export const runtime = 'nodejs';

// GET /api/metricool?blogId=4308292
// Probes multiple Metricool endpoints; returns the full upstream body so we can see exactly what's rejected.
export async function GET(req: NextRequest) {
  // --- Auth guard (defense in depth; matches drafts/opus routes) ---
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Reaches a resource that belongs to the clinic, not to a user, so a valid
  // session is the weaker question. Middleware enforces this too; this is the
  // copy that stays correct if the middleware exemption ever widens again.
  if (!isAllowedEmail(user.email)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
      { status: 403 },
    );
  }

  const token = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  if (!token || !userId) {
    return NextResponse.json({ error: 'METRICOOL_USER_TOKEN and METRICOOL_USER_ID must be configured in Vercel env' }, { status: 500 });
  }
  const blogId = req.nextUrl.searchParams.get('blogId') || DEFAULT_BLOG_ID;
  // Never take blogId on trust: the shared org token can reach several brand
  // profiles, so an arbitrary id would let one user read another brand's data.
  if (!isAllowedBlogId(blogId)) {
    return NextResponse.json({ error: 'Unknown brand profile' }, { status: 400 });
  }
  const today = new Date();
  const start = new Date(today.getTime() - 30 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const base = 'https://app.metricool.com/api';
  // encodeURIComponent so a crafted blogId can't smuggle extra query params
  // (e.g. &userId=...) into the token-authenticated upstream request.
  const eBlog = encodeURIComponent(blogId);
  const eUser = encodeURIComponent(userId);
  const qs = 'blogId=' + eBlog + '&userId=' + eUser + '&start=' + fmt(start) + '&end=' + fmt(today);
  const candidates = [
    base + '/v2/analytics/posts?' + qs,
    base + '/v2/analytics/web?' + qs,
    base + '/admin/simpleProfiles?blogId=' + eBlog + '&userId=' + eUser,
    base + '/stats/web?' + qs,
  ];
  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { 'X-Mc-Auth': token, 'Accept': 'application/json' } });
      const text = await r.text();
      let body: any;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 800) }; }
      // Keep the upstream body server-side only: it can carry account
      // identifiers and internal error detail. The client gets status codes.
      attempts.push({ url, status: r.status, ok: r.ok });
      if (!r.ok) console.error('Metricool analytics error', url, r.status, text.slice(0, 500));
      if (r.ok) {
        // Note: no userId in the payload — it's server config, not client data.
        return NextResponse.json({ blogId, range: { start: fmt(start), end: fmt(today) }, endpoint: url, data: body });
      }
    } catch (e: any) {
      console.error('Metricool analytics exception', url, e && e.message ? e.message : String(e));
      attempts.push({ url, error: 'request failed' });
    }
  }
  return NextResponse.json({ error: 'All Metricool endpoints rejected the request', attempts }, { status: 502 });
}

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { isAllowedEmail, isAllowedBlogId } from '@/lib/access';

// GET /api/metricool/insights?blogId=123
// Aggregates several Metricool datasets in one call so the dashboard can show
// scheduled posts, recent post performance, and best-time-to-post hints without
// the client making multiple round-trips. Auth mirrors the sibling routes:
// the METRICOOL_USER_TOKEN is sent in the X-Mc-Auth header and the userId is a
// query param. Everything is best-effort: if one dataset fails we still return
// the others so a single Metricool hiccup never blanks the whole panel.

export const dynamic = 'force-dynamic';

const BASE = 'https://app.metricool.com/api';

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function mcGet(path: string, token: string): Promise<any> {
  try {
    const res = await fetch(BASE + path, {
      headers: { 'X-Mc-Auth': token, 'Accept': 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  // Explicit session guard, matching every sibling Metricool route (defense in
  // depth — middleware covers this path today, but don't rely on it alone).
  try {
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
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.METRICOOL_USER_TOKEN || '';
  const userId = process.env.METRICOOL_USER_ID || '';
  const { searchParams } = new URL(request.url);
  const blogId = searchParams.get('blogId') || '';

  if (!token || !userId || !blogId) {
    return NextResponse.json({ blogId, scheduled: [], posts: [], bestTimes: null, ok: false });
  }
  // Only brand profiles this deployment owns — the shared org token can reach
  // others, so an arbitrary blogId must not be forwarded upstream.
  if (!isAllowedBlogId(blogId)) {
    return NextResponse.json({ error: 'Unknown brand profile' }, { status: 400 });
  }

  const now = new Date();
  const start = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const q = 'userId=' + encodeURIComponent(userId) + '&blogId=' + encodeURIComponent(blogId);
  const range = 'start=' + fmtDate(start) + '&end=' + fmtDate(now);

  const [scheduledRaw, postsRaw] = await Promise.all([
    mcGet('/v2/scheduler/posts?' + q + '&start=' + fmtDate(now) + '&end=' + fmtDate(future), token),
    mcGet('/v2/analytics/posts?' + q + '&' + range, token),
  ]);

  const asArray = (x: any): any[] => {
    if (Array.isArray(x)) return x;
    if (x && Array.isArray(x.data)) return x.data;
    if (x && Array.isArray(x.posts)) return x.posts;
    if (x && Array.isArray(x.items)) return x.items;
    return [];
  };

  const scheduled = asArray(scheduledRaw);
  const posts = asArray(postsRaw);

  return NextResponse.json({
    blogId,
    ok: true,
    scheduledCount: scheduled.length,
    scheduled: scheduled.slice(0, 20),
    posts: posts.slice(0, 20),
  });
}

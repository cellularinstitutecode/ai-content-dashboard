// web/app/api/stats/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// GET /api/stats
// Returns headline counters for the dashboard: total drafts, scheduled posts,
// upcoming (future) posts, and clip jobs — all scoped to the signed-in user by RLS.
export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const nowIso = new Date().toISOString();

  const [drafts, posts, upcoming, clips] = await Promise.all([
    sb.from('drafts').select('*', { count: 'exact', head: true }),
    sb.from('posts').select('*', { count: 'exact', head: true }),
    sb.from('posts').select('*', { count: 'exact', head: true }).gte('publication_date', nowIso),
    sb.from('clips').select('*', { count: 'exact', head: true }),
  ]);

  return NextResponse.json({
    drafts: drafts.count ?? 0,
    scheduledPosts: posts.count ?? 0,
    upcomingPosts: upcoming.count ?? 0,
    clips: clips.count ?? 0,
  });
}

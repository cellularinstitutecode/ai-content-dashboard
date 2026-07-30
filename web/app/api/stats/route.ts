// web/app/api/stats/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// GET /api/stats
// Returns headline counters for the dashboard: total drafts, scheduled posts,
// upcoming (future) posts, and clip jobs — all scoped to the signed-in user by RLS.
// Keys match the client-side LiveContent stats shape (drafts/scheduled/upcoming/clips);
// descriptive aliases are also included for other consumers.
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

  const draftsCount = drafts.count ?? 0;
  const scheduledCount = posts.count ?? 0;
  const upcomingCount = upcoming.count ?? 0;
  const clipsCount = clips.count ?? 0;

  return NextResponse.json({
    drafts: draftsCount,
    scheduled: scheduledCount,
    upcoming: upcomingCount,
    clips: clipsCount,
    // Descriptive aliases (kept for any other consumers).
    scheduledPosts: scheduledCount,
    upcomingPosts: upcomingCount,
  });
}

// web/app/api/metricool/sync/route.ts
// Pulls recent post analytics from Metricool and upserts them into post_metrics
// for the signed-in user. This is the write side of the performance feedback
// loop; generation reads the stored rows to bias new content.
import { NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';
import { fetchPostMetrics } from '@/lib/performance';

export const runtime = 'nodejs';

// POST /api/metricool/sync
// Fetches the last 30 days of post metrics and stores them. Returns a count.
export async function POST() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const metrics = await fetchPostMetrics(30);
  if (metrics.length === 0) {
    // Nothing to store (no credentials, empty range, or unreadable payload).
    return NextResponse.json({ ok: true, synced: 0 });
  }

  const rows = metrics.map((m) => ({
    user_id: user.id,
    network: m.network,
    external_id: m.externalId,
    text: m.text,
    published_at: m.publishedAt,
    impressions: m.impressions,
    engagement: m.engagement,
    fetched_at: new Date().toISOString(),
  }));

  const admin = supabaseAdmin();
  const { error } = await admin
    .from('post_metrics')
    .upsert(rows, { onConflict: 'user_id,network,external_id' });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, synced: rows.length });
}

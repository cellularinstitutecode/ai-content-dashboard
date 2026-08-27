// web/app/api/metricool/sync/route.ts
// Pulls recent post analytics from Metricool and upserts them into post_metrics.
// This is the write side of the performance feedback loop; generation reads the
// stored rows to bias new content.
//
// Two entry points:
//   POST  - authenticated, user-triggered. Stores metrics for the signed-in user.
//   GET   - invoked by the scheduler (Vercel Cron) with a bearer CRON_SECRET.
//           Metricool credentials are a single org-wide account, so the same
//           metrics are stored for every user that has a brand profile.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { fetchPostMetrics, type NormalizedMetric } from '@/lib/performance';

export const runtime = 'nodejs';
// Metricool + upsert can exceed the default; give the cron room.
export const maxDuration = 60;

// Map normalized metrics to post_metrics rows for a given owner.
function toRows(userId: string, metrics: NormalizedMetric[]) {
  const now = new Date().toISOString();
  return metrics.map((m) => ({
    user_id: userId,
    network: m.network,
    external_id: m.externalId,
    text: m.text,
    published_at: m.publishedAt,
    impressions: m.impressions,
    engagement: m.engagement,
    fetched_at: now,
  }));
}

async function store(userId: string, metrics: NormalizedMetric[]): Promise<number> {
  if (metrics.length === 0) return 0;
  const admin = supabaseAdmin();
  const rows = toRows(userId, metrics);
  const { error } = await admin
    .from('post_metrics')
    .upsert(rows, { onConflict: 'user_id,network,external_id' });
  if (error) throw new Error(error.message);
  return rows.length;
}

// POST /api/metricool/sync
// Fetches the last 30 days of post metrics and stores them for the caller.
export async function POST() {
  // This route reads the ORG-WIDE Metricool account and writes the result into
  // rows owned by the caller, so "a valid session" is the wrong question - it
  // has to be one of our people. Middleware enforces the allowlist too; this is
  // the copy that stays correct if middleware's machine-path exemption ever
  // widens again.
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const metrics = await fetchPostMetrics(30);
  try {
    const synced = await store(auth.userId, metrics);
    return NextResponse.json({ ok: true, synced });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'sync_failed' }, { status: 500 });
  }
}

// GET /api/metricool/sync
// Scheduler entry point. Requires 'Authorization: Bearer <CRON_SECRET>'.
// Fans the org-wide metrics out to every user that has a brand profile.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const metrics = await fetchPostMetrics(30);
  if (metrics.length === 0) {
    return NextResponse.json({ ok: true, users: 0, synced: 0 });
  }

  const admin = supabaseAdmin();
  const { data: owners, error: ownersErr } = await admin
    .from('brand_profiles')
    .select('user_id');
  if (ownersErr) {
    return NextResponse.json({ error: ownersErr.message }, { status: 500 });
  }

  const ids = Array.from(new Set((owners ?? []).map((o: any) => o.user_id).filter(Boolean)));

  // `fetchPostMetrics` reads ONE org-wide Metricool account (shared token +
  // blogId), so fanning the same rows out to every user makes one tenant's
  // post text show up as another tenant's "top-performing posts" inside the
  // generation prompt. With a single owner that is exactly right; with more
  // than one it has to be a deliberate choice.
  if (ids.length > 1 && process.env.METRICOOL_SHARED_ACCOUNT !== 'true') {
    return NextResponse.json({
      ok: false,
      users: ids.length,
      synced: 0,
      error: 'Multiple accounts share one Metricool profile. Set METRICOOL_SHARED_ACCOUNT=true to confirm they should all receive the same metrics.',
    }, { status: 409 });
  }

  let synced = 0;
  for (const id of ids) {
    try {
      synced += await store(id as string, metrics);
    } catch {
      // Skip a failing user rather than aborting the whole run.
    }
  }
  return NextResponse.json({ ok: true, users: ids.length, synced });
}

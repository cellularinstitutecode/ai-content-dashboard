// web/app/api/autopilot/runs/route.ts
// The reviewer's API for the Autopilot queue.
//   GET  → the signed-in user's runs (joined with template name + draft pack).
//   POST → { id, action: 'approve' | 'skip' | 'run_now' }
// Approve is the only path toward publishing, and it only ever creates a
// Metricool DRAFT (autoPublish: false) plus a pending_review posts row.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';
import { advanceRuns, approveRun, regenerateRun, skipRun } from '@/lib/autopilot';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = req.nextUrl;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);

  const db = supabaseAdmin();
  const { data: runs, error } = await db
    .from('template_runs')
    .select('id, template_id, scheduled_for, state, brief, angle, score, draft_id, log, updated_at')
    .eq('user_id', user.id)
    .in('state', ['planned', 'researched', 'drafted', 'ready_for_review', 'failed'])
    .gte('scheduled_for', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = Array.isArray(runs) ? runs : [];
  const templateIds = Array.from(new Set(rows.map((r: { template_id: string }) => r.template_id)));
  const draftIds = rows.map((r: { draft_id: string | null }) => r.draft_id).filter(Boolean) as string[];

  const names: Record<string, string> = {};
  if (templateIds.length) {
    const { data: ts } = await db
      .from('schedule_templates').select('id, name, providers').in('id', templateIds);
    for (const t of ts || []) {
      names[(t as { id: string }).id] = (t as { name?: string }).name || 'Untitled template';
    }
  }
  const packs: Record<string, unknown> = {};
  if (draftIds.length) {
    const { data: ds } = await db.from('drafts').select('id, pack').in('id', draftIds);
    for (const d of ds || []) packs[(d as { id: string }).id] = (d as { pack: unknown }).pack;
  }

  // Variety proof: the last few decided angles per template, so each card can
  // show what the previous occurrences targeted.
  const history: Record<string, { query: string; type: string }[]> = {};
  try {
    const { data: past } = await db
      .from('template_runs')
      .select('template_id, angle, scheduled_for')
      .eq('user_id', user.id)
      .not('angle', 'is', null)
      .order('scheduled_for', { ascending: false })
      .limit(40);
    for (const p of past || []) {
      const tid = String((p as { template_id: string }).template_id);
      const a = (p as { angle?: { query?: string; type?: string } }).angle;
      if (!a?.query) continue;
      if (!history[tid]) history[tid] = [];
      if (history[tid].length < 4) history[tid].push({ query: a.query, type: String(a.type || '') });
    }
  } catch { /* optional */ }

  return NextResponse.json({
    runs: rows.map((r: Record<string, unknown>) => ({
      ...r,
      template_name: names[String(r.template_id)] || 'Template',
      pack: r.draft_id ? packs[String(r.draft_id)] ?? null : null,
      recent_angles: (history[String(r.template_id)] || []).filter(
        (h) => h.query !== (r.angle as { query?: string } | null)?.query
      ),
    })),
  });
}

export async function POST(req: NextRequest) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = typeof body.id === 'string' ? body.id : '';
  const action = typeof body.action === 'string' ? body.action : '';
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 });

  if (action === 'approve') {
    const result = await approveRun(id, user.id);
    if (!result.ok) return NextResponse.json({ error: result.note }, { status: 400 });
    return NextResponse.json({ ok: true, note: result.note });
  }
  if (action === 'skip') {
    const ok = await skipRun(id, user.id);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  if (action === 'run_now') {
    const result = await advanceRuns({ scopeUserId: user.id, runId: id, budgetMs: 45_000, maxRuns: 1 });
    return NextResponse.json({ ok: true, ...result });
  }
  if (action === 'regenerate') {
    const note = typeof body.note === 'string' ? body.note : '';
    const ok = await regenerateRun(id, user.id, note);
    if (!ok) return NextResponse.json({ error: 'run cannot be regenerated' }, { status: 400 });
    // Redraft immediately so the reviewer gets the new version in one click.
    const result = await advanceRuns({ scopeUserId: user.id, runId: id, budgetMs: 45_000, maxRuns: 1 });
    return NextResponse.json({ ok: true, ...result });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}

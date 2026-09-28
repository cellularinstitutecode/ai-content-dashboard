// web/app/api/strategy/performance/route.ts
// GET → how each pillar and caption shape of the weekly strategy is doing.
//
// Reads only this account's own rows: the strategy templates, their approved
// runs of the last LOOK_BACK_DAYS, the live `posts` rows those runs sent (the
// exact text and time each network got), and the Metricool numbers the daily
// sync stored in post_metrics. No Metricool call —
// the page can open as often as it likes without spending the shared account.
// The matching and the sums are lib/strategy-performance.ts.
import { NextResponse } from 'next/server';
import { isAllowedEmail } from '@/lib/access';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isLivePost, strategyPerformance, type PerfMetric, type PerfRun, type SentPost } from '@/lib/strategy-performance';

export const runtime = 'nodejs';

const LOOK_BACK_DAYS = 90;

export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isAllowedEmail(user.email)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
      { status: 403 },
    );
  }
  const rl = await checkRateLimit(user.id, 'strategy-performance');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  try {
    const db = supabaseAdmin();
    const since = new Date(Date.now() - LOOK_BACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: templates, error: tErr } = await db
      .from('schedule_templates').select('id, strategy').eq('user_id', user.id);
    if (tErr) throw tErr;
    const slotOf = new Map<string, string>();
    for (const t of templates || []) {
      // The engine's own test for a strategy slot (isStrategySlot): seeded by
      // "Load the weekly strategy", with a slot key.
      const st = (t as { strategy?: { slot?: string; seeded?: string } }).strategy;
      const slot = String(st?.slot || '').trim().toLowerCase();
      if (slot && String(st?.seeded || '') === 'weekly-strategy') slotOf.set(String((t as { id: string }).id), slot);
    }
    if (!slotOf.size) return NextResponse.json({ loaded: false, days: LOOK_BACK_DAYS });

    const { data: runs, error: rErr } = await db
      .from('template_runs')
      .select('id, template_id, scheduled_for, angle, draft_id')
      .eq('user_id', user.id)
      .eq('state', 'approved')
      .in('template_id', [...slotOf.keys()])
      .gte('scheduled_for', since)
      .order('scheduled_for', { ascending: false })
      .limit(400);
    if (rErr) throw rErr;

    // What each run actually sent: one `posts` row per network, carrying the
    // text that went out and the time Metricool was given. Only live ones —
    // approved and due — so a Metricool draft or a post still to come is not
    // counted as published.
    const draftIds = [...new Set((runs || []).map((r) => (r as { draft_id?: string | null }).draft_id).filter(Boolean) as string[])];
    const sentBy = new Map<string, SentPost[]>();
    const now = Date.now();
    for (let i = 0; i < draftIds.length; i += 100) {
      const { data: ps, error: pErr } = await db
        .from('posts')
        .select('draft_id, providers, text, publication_date, status')
        .in('draft_id', draftIds.slice(i, i + 100))
        .eq('user_id', user.id);
      if (pErr) throw pErr;
      for (const p of ps || []) {
        const row = p as { draft_id: string; providers?: string[] | null; text?: string | null; publication_date?: string | null; status?: string | null };
        if (!isLivePost(row, now)) continue;
        const list = sentBy.get(row.draft_id) || [];
        list.push({ network: String(row.providers?.[0] || ''), text: String(row.text || ''), at: String(row.publication_date) });
        sentBy.set(row.draft_id, list);
      }
    }

    const perfRuns: PerfRun[] = (runs || []).map((r) => {
      const row = r as { id: string; template_id: string; scheduled_for: string; angle?: PerfRun['angle']; draft_id?: string | null };
      return {
        id: row.id,
        slot: slotOf.get(String(row.template_id)) || '',
        scheduled_for: row.scheduled_for,
        angle: row.angle ?? null,
        sent: row.draft_id ? sentBy.get(row.draft_id) || [] : [],
      };
    });

    const { data: metrics, error: mErr } = await db
      .from('post_metrics')
      .select('network, text, published_at, impressions, engagement')
      .eq('user_id', user.id)
      .gte('published_at', since)
      .limit(3000);
    if (mErr) throw mErr;

    return NextResponse.json({
      loaded: true,
      days: LOOK_BACK_DAYS,
      ...strategyPerformance(perfRuns, (metrics || []) as PerfMetric[]),
    });
  } catch (err) {
    reportError('strategy-performance', err, { userId: user.id });
    return NextResponse.json({ error: 'Could not read the strategy performance just now.' }, { status: 500 });
  }
}

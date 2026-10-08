// web/app/api/autopilot/runs/route.ts
// The reviewer's API for the Autopilot queue.
//   GET  → the signed-in user's runs (joined with template name + draft pack).
//   POST → { id, action: 'approve' | 'skip' | 'run_now' | 'regenerate' | 'fix' | 'reschedule' (with scheduled_for) }
// Approve is the only path toward publishing, and it only ever creates a
// Metricool DRAFT (autoPublish: false) plus a pending_review posts row.
import { isAllowedEmail } from '@/lib/access';
import { reportError } from '@/lib/report';
import { NextRequest, NextResponse, after } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { advanceRuns, approveRun, fixRunInBackground, regenerateRun, skipRun, rescheduleRun, startFix } from '@/lib/autopilot';
import { checkRateLimit } from '@/lib/rate-limit';
import { bucketRuns, DEFAULT_LIMITS, FAILED_WINDOW_DAYS } from '@/lib/review-queue';
import { wantsBlog } from '@/lib/metricool-networks';
import { attachableClip } from '@/lib/clip-relevance';

export const runtime = 'nodejs';
// 300, not 60. The approve path runs ensureDraftImage — which lib/images.ts
// itself documents as taking 30-60s — and then Metricool media normalisation and
// the scheduler POST. A 60s ceiling against that is not a rare overrun, it is the
// expected case on a cold draft, and a platform kill mid-approve strands the run
// in `approved` where nothing can reach it.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
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

  const url = req.nextUrl;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);

  const db = supabaseAdmin();
  // `attempts` is here because the card has to tell a stalled run from an
  // expired one, and that turns on whether the attempts were spent. It was the
  // one field the engine decides on (autopilot.ts: `attempts >= MAX_ATTEMPTS ?
  // 'failed' : startedFrom`) that never reached the screen, so the screen could
  // not reach the same conclusion the engine had.
  const COLUMNS = 'id, template_id, scheduled_for, state, attempts, brief, angle, score, draft_id, log, updated_at';
  const now = Date.now();
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const failedSince = new Date(now - FAILED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Three reads, each limited on its own (lib/review-queue.ts).
  //
  // This used to be two reads merged, sorted ascending and cut to 20 — and
  // failed runs of ANY age were one of them. Failures are never deleted, so
  // once twenty had piled up they sorted first and filled every row: the posts
  // waiting for approval fell off the end and nothing could be approved from
  // the screen. And a finished post nobody approved within a day of its slot
  // dropped out of the recent window for good.
  //
  //   ready     every post waiting for a decision, whatever its age — a missed
  //             one is shown as missed, not hidden;
  //   in flight posts still being prepared, from a day back;
  //   failed    the last FAILED_WINDOW_DAYS only, newest first.
  //
  // Kept as plain queries rather than one `.or(...)`: the filter values are
  // timestamps, and a broken filter here would take the whole panel down.
  const [ready, inFlight, failed] = await Promise.all([
    db.from('template_runs').select(COLUMNS)
      .eq('user_id', user.id)
      .eq('state', 'ready_for_review')
      .order('scheduled_for', { ascending: true })
      .limit(DEFAULT_LIMITS.ready),
    db.from('template_runs').select(COLUMNS)
      .eq('user_id', user.id)
      .in('state', ['planned', 'researched', 'drafted'])
      .gte('scheduled_for', since)
      .order('scheduled_for', { ascending: true })
      .limit(limit),
    db.from('template_runs').select(COLUMNS)
      .eq('user_id', user.id)
      .eq('state', 'failed')
      .gte('scheduled_for', failedSince)
      .order('scheduled_for', { ascending: false })
      .limit(limit),
  ]);
  const error = ready.error || inFlight.error || failed.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = bucketRuns(
    { ready: ready.data as any[], inFlight: inFlight.data as any[], failed: failed.data as any[] },
    now,
    { ready: DEFAULT_LIMITS.ready, inFlight: limit, failed: limit },
  );
  const templateIds = Array.from(new Set(rows.map((r: { template_id: string }) => r.template_id)));
  const draftIds = rows.map((r: { draft_id: string | null }) => r.draft_id).filter(Boolean) as string[];

  const names: Record<string, string> = {};
  // The channels each template sends to. The card needs them: a run that
  // writes the weekly article cannot be approved as a draft (see
  // app/AutopilotQueue.tsx), because nothing here could publish the
  // WordPress draft that leaves behind.
  const providersOf: Record<string, string[]> = {};
  /** Each template's strategy, so the card names only a clip approve will attach. */
  const strategyOf: Record<string, Record<string, unknown> | null> = {};
  if (templateIds.length) {
    const { data: ts } = await db
      .from('schedule_templates').select('id, name, providers, strategy').in('id', templateIds).eq('user_id', user.id);
    for (const t of ts || []) {
      names[(t as { id: string }).id] = (t as { name?: string }).name || 'Untitled template';
      providersOf[(t as { id: string }).id] = ((t as { providers?: string[] | null }).providers || []).map(String);
      strategyOf[(t as { id: string }).id] = (t as { strategy?: Record<string, unknown> | null }).strategy ?? null;
    }
  }
  const packs: Record<string, unknown> = {};
  if (draftIds.length) {
    // Scoped to the caller. `draft_id` lives on template_runs, which the RLS
    // policy let a user UPDATE on their own row - so pointing it at someone
    // else's draft made this service-role read hand back their pack.
    const { data: ds } = await db
      .from('drafts').select('id, pack').in('id', draftIds).eq('user_id', user.id);
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
      // Retired because the slot moved: never a post, so not a "previous occurrence".
      .neq('state', 'superseded')
      .order('scheduled_for', { ascending: false })
      // One read for every template, four entries each: 40 was written for a
      // handful of templates, and across the strategy's fifteen slots it left
      // two or three per card.
      .limit(160);
    for (const p of past || []) {
      const tid = String((p as { template_id: string }).template_id);
      const a = (p as { angle?: { query?: string; type?: string } }).angle;
      if (!a?.query) continue;
      if (!history[tid]) history[tid] = [];
      if (history[tid].length < 4) history[tid].push({ query: a.query, type: String(a.type || '') });
    }
  } catch (err) { /* optional */ reportError('autopilot-runs:angle-history', err); }

  return NextResponse.json({
    runs: rows.map((r: Record<string, unknown>) => ({
      ...r,
      angle: r.angle && typeof r.angle === 'object'
        ? {
            ...(r.angle as Record<string, unknown>),
            media: attachableClip(
              r.angle as Parameters<typeof attachableClip>[0],
              strategyOf[String(r.template_id)],
              names[String(r.template_id)],
            ),
          }
        : r.angle,
      template_name: names[String(r.template_id)] || 'Template',
      template_providers: providersOf[String(r.template_id)] || [],
      // The approve step's own rule (wantsBlog trims and lower-cases), so the
      // card and the server agree on which runs write the WordPress article.
      writes_article: wantsBlog(providersOf[String(r.template_id)] || []),
      pack: r.draft_id ? packs[String(r.draft_id)] ?? null : null,
      recent_angles: (history[String(r.template_id)] || []).filter(
        (h) => h.query !== (r.angle as { query?: string } | null)?.query
      ),
    })),
  });
}

export async function POST(req: NextRequest) {
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

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const id = typeof body.id === 'string' ? body.id : '';
  const action = typeof body.action === 'string' ? body.action : '';
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 });

  if (action === 'approve') {
    // CAPPED, like run_now and regenerate below. Approve is the most expensive
    // action in the app — it runs a paid image generation, Metricool media
    // normalisation and the scheduler POST — and it was the one left uncapped,
    // so holding the button was an uncapped spend loop whose repeats could also
    // each create another live Metricool post.
    const rl = await checkRateLimit(user.id, 'autopilot-action');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }
    // `schedule: true` is the reviewer's explicit "Approve & schedule" — the
    // post goes into Metricool's live queue instead of its review queue. It is
    // read only from the request a signed-in reviewer sent; the engine has no
    // path to it.
    // `redate: true` is "Approve for next free slot" on a card whose time has
    // already passed. Without it approveRun refuses a past slot rather than
    // sending Metricool a date it will not accept.
    // A person pressed the button: a citation problem is remarked, not refused.
    const result = await approveRun(id, user.id, { schedule: body?.schedule === true, redate: body?.redate === true, remarkCitation: true });
    if (!result.ok) return NextResponse.json({ error: result.note }, { status: 400 });
    return NextResponse.json({ ok: true, note: result.note });
  }
  if (action === 'reschedule') {
    const when = typeof body.scheduled_for === 'string' ? body.scheduled_for : '';
    if (!when || isNaN(new Date(when).getTime())) return NextResponse.json({ error: 'scheduled_for must be a valid ISO date' }, { status: 400 });
    const result = await rescheduleRun(id, user.id, when);
    if (!result.ok) return NextResponse.json({ error: 'not_moved', message: result.note }, { status: 409 });
    return NextResponse.json({ ok: true });
  }
  if (action === 'skip') {
    const ok = await skipRun(id, user.id);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'run not found' }, { status: 404 });
  }
  // run_now / regenerate / fix each drive a full LLM generation pipeline.
  // Capped like every other AI route.
  if (action === 'run_now' || action === 'regenerate' || action === 'fix') {
    const rl = await checkRateLimit(user.id, 'autopilot-action');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }
  }
  if (action === 'run_now') {
    const result = await advanceRuns({ scopeUserId: user.id, runId: id, budgetMs: 45_000, maxRuns: 1 });
    // A Retry that moved nothing is not a success, and saying `ok: true` for it
    // is how a switched-off template swallowed every retry a reviewer pressed —
    // silently, and for as long as they kept pressing. advanceRuns now reports
    // why it stood down; the only honest thing to do is pass that on.
    if (!result.advanced && result.skipped.length) {
      return NextResponse.json(
        { error: 'not_advanced', message: result.skipped.join(' '), ...result },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  }
  if (action === 'regenerate') {
    const note = typeof body.note === 'string' ? body.note : '';
    const ok = await regenerateRun(id, user.id, note);
    if (!ok) {
      return NextResponse.json({
        error: 'run cannot be regenerated',
        message: 'This post cannot be redrafted. If its time has already passed, use "Approve for next free slot" or skip it.',
      }, { status: 400 });
    }
    // Redraft immediately so the reviewer gets the new version in one click.
    const result = await advanceRuns({ scopeUserId: user.id, runId: id, budgetMs: 45_000, maxRuns: 1 });
    // Same rule as run_now: regenerateRun succeeded, but if the redraft then
    // stood down the reviewer is owed the reason rather than a tidy ok.
    if (!result.advanced && result.skipped.length) {
      return NextResponse.json(
        { error: 'not_advanced', message: result.skipped.join(' '), ...result },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  }
  if (action === 'fix') {
    // FIX resolves every warning on the card — citation, copy, image — and
    // re-checks (lib/autopilot.ts fixRun). It takes minutes, so the request
    // only starts it: the work runs after the response (inside this route's
    // maxDuration), and its progress and result land on the run (angle.fix),
    // which the card polls. Holding the request open instead is what left the
    // card behind a loader at 94% for the whole of it.
    // Two buttons, two scopes: "Fix citation" repairs the citation and only
    // the citation (never a redraft, never a new picture); FIX repairs the
    // copy and the picture.
    // One button per repair, each its own AI cost: 'citation', 'image' or 'copy'.
    // No scope (an older page) is the copy and the picture together, never the citation.
    // 'all' is the citation and the image together, run at the same time (one press, one wait).
    const scope: 'citation' | 'image' | 'copy' | 'all' | 'general' = body.scope === 'citation' || body.scope === 'image' || body.scope === 'copy' || body.scope === 'all' ? body.scope : 'general';
    const started = await startFix(id, user.id, scope === 'general' ? ['copy', 'image'] : scope === 'all' ? ['citation', 'image'] : [scope]);
    if (!started.ok) return NextResponse.json({ error: 'fix_refused', message: started.note }, { status: 400 });
    after(() => fixRunInBackground(id, user.id, scope));
    const what = scope === 'general' ? 'FIX is working on it' : scope === 'all' ? 'Fixing the citation and the image together' : 'Fixing the ' + scope;
    return NextResponse.json({ ok: true, started: true, note: what + '. The card updates when it is done (usually one to four minutes).' }, { status: 202 });
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}

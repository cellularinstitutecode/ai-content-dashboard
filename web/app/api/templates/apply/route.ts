// web/app/api/templates/apply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { SCHEDULE_TZ, upcomingSlots } from '@/lib/timezone';
import { metricoolConfigured, metricoolSchedulePost, readPostId, type Provider } from '@/lib/metricool';
import { reportError } from '@/lib/report';
import { isAllowedEmail } from '@/lib/access';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// Each slot is one upstream Metricool call now, so the default 10s is too tight.
export const maxDuration = 60;

// The most slots one click may create. A template can describe up to 12 weeks x
// 7 weekdays; sending 84 posts to Metricool from one request would outrun the
// function budget and half-finish. Ask for a smaller window instead.
const MAX_SLOTS = 40;
// Leave room to answer before the platform kills the function.
const TIME_BUDGET_MS = 45_000;

// POST /api/templates/apply
// Body: { id: string, weeks?: number }
//
// Creates the template's upcoming posts for the next N weeks (default 4), in
// the clinic's timezone, AND schedules each one in Metricool as a draft.
//
// This route used to insert rows into the local `posts` table and stop there.
// Nothing else in the codebase ever sent those rows anywhere, so they rendered
// as blue "Scheduled" chips on the dashboard and the calendar and then simply
// never published - a clinic could believe a month of content was queued while
// nothing had been handed to any channel. Two smaller faults rode along: a
// second click duplicated every slot, and an AI/pillars template (whose `text`
// is empty by design) produced a run of blank posts.
export async function POST(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // This route now writes into the clinic's shared Metricool account, so it
  // carries the same allowlist gate as every other route that does - the
  // repo's own route-policy test enforces this.
  if (!isAllowedEmail(user.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // One click can create dozens of scheduled posts upstream. Cap it like every
  // other route that spends a shared resource.
  const rl = await checkRateLimit(user.id, 'schedule');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const id = body && body.id;
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const weeks = Math.min(Math.max(Number(body.weeks) || 4, 1), 12);

  if (!metricoolConfigured()) {
    return NextResponse.json(
      {
        error: 'metricool_not_configured',
        message: 'Metricool is not connected, so these posts could not be scheduled anywhere. Nothing was created.',
      },
      { status: 503 },
    );
  }

  const { data: tpl, error: tErr } = await sb
    .from('schedule_templates')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  if (!tpl) return NextResponse.json({ error: 'template not found' }, { status: 404 });

  const weekdays: number[] = Array.isArray(tpl.weekdays) ? tpl.weekdays : [];
  const providers: string[] = Array.isArray(tpl.providers) ? tpl.providers : [];
  if (weekdays.length === 0) {
    return NextResponse.json({ error: 'template has no weekdays selected' }, { status: 400 });
  }
  if (providers.length === 0) {
    return NextResponse.json({ error: 'template has no providers selected' }, { status: 400 });
  }

  // An AI template carries no fixed text - Autopilot writes each post the day
  // it is due. Materialising it here would schedule empty posts.
  const text = String(tpl.text || '').trim();
  if (!text) {
    return NextResponse.json(
      {
        error: 'template_has_no_text',
        message: 'This template writes each post with AI, so there is nothing to schedule ahead of time. Autopilot prepares these for you - review them in the Autopilot queue.',
      },
      { status: 400 },
    );
  }

  // Template times are clinic-local wall-clock times (America/Cancun by
  // default) - build the instants through the shared timezone helper so a
  // 09:00 template lands at 09:00 in Cancun, not 09:00 UTC.
  const slots = upcomingSlots(weekdays, tpl.time_of_day || '09:00', weeks * 7, SCHEDULE_TZ);
  if (slots.length === 0) {
    return NextResponse.json({ created: 0, skipped: 0, failed: 0, posts: [] });
  }
  if (slots.length > MAX_SLOTS) {
    return NextResponse.json(
      {
        error: 'too_many_slots',
        message: 'That would create ' + slots.length + ' posts in one go. Apply a shorter window (' + MAX_SLOTS + ' posts or fewer) and repeat it later.',
      },
      { status: 400 },
    );
  }

  // Idempotency. `posts` has no unique constraint, so a second click used to
  // duplicate every slot. Anything this user already has at the same instant
  // with the same text is treated as already applied.
  const first = slots[0].toISOString();
  const last = slots[slots.length - 1].toISOString();
  const { data: existing } = await sb
    .from('posts')
    .select('publication_date, text')
    .eq('user_id', user.id)
    .gte('publication_date', first)
    .lte('publication_date', last);
  const taken = new Set(
    (existing || [])
      .filter((row: any) => String(row.text || '').trim() === text)
      .map((row: any) => new Date(row.publication_date).getTime()),
  );

  const started = Date.now();
  const created: any[] = [];
  const failures: string[] = [];
  let skipped = 0;
  let notAttempted = 0;

  for (const slot of slots) {
    if (taken.has(slot.getTime())) { skipped++; continue; }
    if (Date.now() - started > TIME_BUDGET_MS) { notAttempted++; continue; }

    let metricoolId: string | null = null;
    try {
      const res = await metricoolSchedulePost({
        text,
        providers: providers as Provider[],
        publicationDate: slot.toISOString(),
      });
      metricoolId = readPostId(res);
    } catch (e) {
      reportError('templates/apply:metricool', e);
      failures.push(slot.toISOString());
      continue;
    }

    const { data: row, error } = await sb
      .from('posts')
      .insert({
        user_id: user.id,
        providers,
        text,
        publication_date: slot.toISOString(),
        metricool_post_id: metricoolId,
        // Same vocabulary the interactive scheduler uses: it is in Metricool,
        // waiting for a human to approve it there.
        status: 'pending_review',
      })
      .select('*')
      .single();
    if (error) {
      // The post IS in Metricool; only our bookkeeping row failed. Say so
      // rather than reporting a clean success.
      reportError('templates/apply:insert', error);
      failures.push(slot.toISOString());
      continue;
    }
    created.push(row);
  }

  const parts: string[] = [];
  parts.push(created.length === 1 ? 'Sent 1 post to Metricool for review.' : 'Sent ' + created.length + ' posts to Metricool for review.');
  if (skipped) parts.push(skipped + ' already existed and were left alone.');
  if (failures.length) parts.push(failures.length + ' could not be scheduled — try again.');
  if (notAttempted) parts.push(notAttempted + ' were not attempted (ran out of time) — apply again to finish.');

  return NextResponse.json({
    created: created.length,
    skipped,
    failed: failures.length,
    notAttempted,
    message: parts.join(' '),
    posts: created,
  }, { status: failures.length && !created.length ? 502 : 200 });
}

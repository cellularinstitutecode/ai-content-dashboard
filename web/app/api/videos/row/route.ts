// POST /api/videos/row  { tab, row }
//
// One row of the video sheet, acted on from the sheet. Two things in the sheet
// call this (docs/video-autopilot.md, "Making it instant"; the script is in
// scripts/sheet-apps-script): the "Prepare checked boxes" panel, with the day
// and time the person chose (`publishAt`), and — when INSTANT_TICKS is on —
// the edit trigger, for every box ticked in a network column. Either way
// lib/video-ticks.ts gives each ticked network that has no draft yet one, from
// the copy already on the row's draft. Nothing is deleted; an unticked box is
// left to the dashboard.
//
// Two callers, the same two the sweep has:
//   1. The Apps Script, with Authorization: Bearer CRON_SECRET — the same
//      bearer the trigger already sends to /api/videos/watch, so the script's
//      one property serves both. Middleware lets it through by value
//      (lib/machine-auth.ts); the row belongs to the sweep owner.
//   2. A signed-in, allowlisted person — the assistant, or a curl while
//      setting the trigger up — scoped to their own account and rate-limited.
//
// Rows that are not prepared yet answer `not_prepared`: preparing is the link
// trigger's and the sweep's job, and this route never spends a transcript.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';
import { resolveOwner } from '@/lib/sweep-owner';
import { addTickedNetworks } from '@/lib/video-ticks';
import { instantTicksEnabled } from '@/lib/tick-add';

export const runtime = 'nodejs';
// The hand-off may have to copy a video into Metricool before a draft that
// needs one can be made; that is the same work the sweep gives 300 s.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const started = Date.now();
  const secret = process.env.CRON_SECRET;
  const isMachine = Boolean(secret) && (req.headers.get('authorization') || '') === 'Bearer ' + secret;
  let userId: string;
  if (isMachine) {
    const owner = await resolveOwner();
    if (!owner.ok) {
      return NextResponse.json({ ok: false, error: 'no_owner', reason: owner.reason, message: owner.detail }, { status: 503 });
    }
    userId = owner.userId;
  } else {
    const auth = await requireAllowlistedUser();
    if (!auth.ok) return auth.response;
    userId = auth.userId;
    const rl = await checkRateLimit(userId, 'video-prepare');
    if (!rl.ok) {
      return NextResponse.json({ ok: false, error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
    }
  }

  let body: { tab?: unknown; row?: unknown; publishAt?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { body = {}; }
  const tab = String(body.tab || '').trim();
  const row = Number(body.row);
  if (!tab || !Number.isInteger(row) || row < 2) {
    return NextResponse.json({ ok: false, error: 'bad_request', message: 'Send { tab, row }: the tab name and the 1-based row number of the edited row.' }, { status: 400 });
  }
  // Optional: when the posts should go out, "YYYY-MM-DDTHH:mm" on the clinic's
  // clock. The sheet's "Prepare checked boxes" panel sends it; the edit trigger
  // does not, and the hand-off then picks the next free slot.
  const publishAt = typeof body.publishAt === 'string' && body.publishAt.trim() ? body.publishAt.trim() : null;
  // No time named: held, not sent. The sheet's edit trigger calls this the
  // moment a box is ticked; the first time the clinic used the ticks that put
  // two posts at slots nobody chose and left the panel nothing to schedule.
  // The box says where; the dashboard's Prepare checked boxes says when.
  // VIDEO_TICK_INSTANT=on restores the old send-at-the-next-free-slot.
  // The hold reads the row and writes a `ticked` line so the panel lists it
  // first (lib/video-ticks.ts hold); it never writes copy or a post.
  const hold = !publishAt && !instantTicksEnabled();

  try {
    const out = await addTickedNetworks({ userId, tab, row, publishAt, hold, budgetMs: 270_000 - (Date.now() - started) });
    return NextResponse.json({ ok: true, ...out }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    // A failure here must LOOK like one in the script's execution log, for the
    // reason /api/videos/watch gives: a swallowed error reads as a quiet click.
    reportError('videos:row', e, { tab, row: String(row) });
    return NextResponse.json(
      { ok: false, error: 'row_failed', message: e instanceof Error ? e.message : 'The row could not be handled.' },
      { status: 500 },
    );
  }
}

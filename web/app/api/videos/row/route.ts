// POST /api/videos/row  { tab, row }
//
// One row of the video sheet, acted on the moment a box is ticked. The sheet's
// Apps Script edit trigger (docs/video-autopilot.md, "Making it instant") calls
// this for every edit in a network column — YOUTUBE, LINKEDIN, TIKTOK, X,
// FACEBOOK, INSTAGRAM — and lib/video-ticks.ts gives each ticked network that
// has no draft yet one, from the copy already on the row's draft. Nothing is
// deleted; an unticked box is left to the dashboard.
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

  let body: { tab?: unknown; row?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { body = {}; }
  const tab = String(body.tab || '').trim();
  const row = Number(body.row);
  if (!tab || !Number.isInteger(row) || row < 2) {
    return NextResponse.json({ ok: false, error: 'bad_request', message: 'Send { tab, row }: the tab name and the 1-based row number of the edited row.' }, { status: 400 });
  }

  try {
    const out = await addTickedNetworks({ userId, tab, row, budgetMs: 270_000 - (Date.now() - started) });
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

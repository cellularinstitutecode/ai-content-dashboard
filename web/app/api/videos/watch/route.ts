// GET|POST /api/videos/watch
//
// The trigger for the video sweep (lib/video-autopilot.ts). Three callers:
//
//   1. The Vercel cron, DAILY at 07:00 UTC (vercel.json), with
//      Authorization: Bearer CRON_SECRET. Daily rather than hourly because
//      Hobby rejects a more frequent cron expression at deploy time — that
//      one is proven, by a real deployment failure. The safety net, not the
//      mechanism: the Apps Script push below is what keeps up.
//   2. A Google Apps Script trigger on the sheet itself, with the same bearer,
//      fired when somebody pastes a link. This is what makes it feel instant.
//      See docs/video-autopilot.md for the script.
//   3. A signed-in person pressing "Check for new videos", which is scoped to
//      their own account and rate-limited.
//
// ?dry=1 reports what WOULD be prepared and writes nothing — the safe way to
// point this at the sheet for the first time.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveOwner, sweepVideos } from '@/lib/video-autopilot';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// The sweep is given a budget below this so it stops starting new videos in
// time to finish the one it is on. 60 was set on a mistaken reading of the
// plan's ceiling — see /api/videos/prepare — and meant a nightly pass could
// clear at most one short video.
export const maxDuration = 300;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const isCron = Boolean(secret) && (req.headers.get('authorization') || '') === 'Bearer ' + secret;

  let userId: string | null = null;
  if (isCron) {
    // resolveOwner rather than resolveSweepUser: WHY there is no owner decides
    // what a person should do about it, and the old message assumed the one
    // cause it could not tell apart from the others — sending someone to press
    // Save on a page they had already saved.
    const owner = await resolveOwner();
    if (!owner.ok) {
      return NextResponse.json(
        { ok: false, error: 'no_owner', reason: owner.reason, message: owner.detail },
        { status: 503 },
      );
    }
    userId = owner.userId;
  } else {
    // A person pressed the button. Allowlist, not merely a session: this spends
    // OpenAI, Anthropic and Semrush credit.
    const auth = await requireAllowlistedUser();
    if (!auth.ok) return auth.response;
    userId = auth.userId;
    const rl = await checkRateLimit(userId, 'video-sweep');
    if (!rl.ok) {
      return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
    }
  }

  const url = req.nextUrl;
  const dryRun = url.searchParams.get('dry') === '1';
  // Fill the sheet but hand nothing to Metricool — for a first run where you
  // want to read the copy before any of it reaches a posting queue.
  const skipMetricool = url.searchParams.get('sheetOnly') === '1';
  const maxParam = Number(url.searchParams.get('max'));
  // The default was ONE, sized for a 60-second function with room for exactly
  // one download-extract-transcribe-write cycle. The function now has 300
  // seconds — and since this route runs on a DAILY cron, a default of one
  // meant the nightly pass cleared at most one video per day. A backlog of
  // thirty would have taken a month, which is not a sweep so much as a queue
  // that never empties.
  //
  // Five is safe because nothing here relies on it: `budgetMs` below stops the
  // sweep STARTING another video once the clock runs down, and each row still
  // owns its own per-step budget. The cap is the ceiling, not the plan.
  const maxVideos = Number.isFinite(maxParam) && maxParam > 0 ? Math.min(maxParam, 10) : 5;

  try {
    const out = await sweepVideos({ userId, dryRun, skipMetricool, maxVideos, budgetMs: 270_000 });
    if (!out.ok) {
      return NextResponse.json(
        { ok: false, error: 'not_configured', message: 'Google access is not set up, so the sheet cannot be read.' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ...out, dryRun }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    // A failure here must LOOK like a failure: a swallowed error reads as a
    // quiet day on the cron dashboard, and nobody notices for a month.
    reportError('videos:watch', e);
    return NextResponse.json(
      { ok: false, error: 'sweep_failed', message: e instanceof Error ? e.message : 'The video sweep failed.' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }

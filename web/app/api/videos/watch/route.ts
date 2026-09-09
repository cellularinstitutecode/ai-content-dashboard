// GET|POST /api/videos/watch
//
// The trigger for the video sweep (lib/video-autopilot.ts). Three callers:
//
//   1. The Vercel cron, hourly (vercel.json), with Authorization: Bearer CRON_SECRET.
//      The safety net — it catches anything the push below missed.
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
import { resolveSweepUser, sweepVideos } from '@/lib/video-autopilot';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// 60 seconds is the Hobby plan's ceiling, and a deployment is REJECTED for
// asking for more — so this is the number that has to work, not a preference.
// The sweep is given a budget below it so it stops starting new videos in time
// to finish the one it is on.
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const isCron = Boolean(secret) && (req.headers.get('authorization') || '') === 'Bearer ' + secret;

  let userId: string | null = null;
  if (isCron) {
    userId = await resolveSweepUser();
    if (!userId) {
      return NextResponse.json(
        {
          ok: false,
          error: 'no_owner',
          message: 'Nobody to write as: there is no saved Brand Brain and no allowlisted account in the database. ' +
            'Open Brand Brain in the dashboard and press Save — that also gives the copy the clinic’s voice instead ' +
            'of the default one. VIDEO_AUTOPILOT_USER_ID overrides this if you need a specific account.',
        },
        { status: 503 },
      );
    }
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
  // One video per request by default. Inside a 60-second function there is
  // room for exactly one download-extract-transcribe-write cycle with margin;
  // asking for more would time out mid-video and lose the work in flight. The
  // sweep comes back for the rest — a run is cheap and idempotent.
  const maxVideos = Number.isFinite(maxParam) && maxParam > 0 ? Math.min(maxParam, 10) : 1;

  try {
    const out = await sweepVideos({ userId, dryRun, skipMetricool, maxVideos, budgetMs: 45_000 });
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

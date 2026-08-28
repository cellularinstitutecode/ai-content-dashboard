// web/app/api/autopilot/tick/route.ts
// The Autopilot heartbeat. Called two ways:
//   1. Vercel Cron (daily, see vercel.json) with Authorization: Bearer CRON_SECRET
//      → plans upcoming runs for ALL users and advances due ones.
//   2. A signed-in user ("Run engine now" button) → same, scoped to that user.
// Steps are idempotent and resumable, so overlapping or repeated ticks are safe.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { advanceRuns, expireStaleRuns, planRuns } from '@/lib/autopilot';
import { reportError } from '@/lib/report';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') || '';
  const isCron = Boolean(secret) && auth === 'Bearer ' + secret;

  let scopeUserId: string | undefined;
  if (!isCron) {
    // Not the cron: a human pressed "Run engine now". Allowlist, not merely a
    // session - this spends Anthropic, OpenAI and Semrush credit.
    const session = await requireAllowlistedUser();
    if (!session.ok) return session.response;
    scopeUserId = session.userId;
    // A tick runs up to 4 research/draft/score pipelines and spends Anthropic,
    // OpenAI and Semrush credit. Every sibling AI route is capped; this one
    // was not, so the "Run engine now" button was an uncapped spend loop.
    const rl = await checkRateLimit(scopeUserId, 'autopilot-tick');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }
  }

  const url = req.nextUrl;
  const runId = url.searchParams.get('runId') || undefined;

  // A failure in any of these used to be swallowed and reported as
  // {ok:true, planned:0, advanced:0} - indistinguishable from a quiet day, and
  // green on the Vercel cron dashboard. Answer with a real status code so a
  // broken engine looks broken.
  try {
    const planned = await planRuns(scopeUserId);
    const expired = await expireStaleRuns(scopeUserId);
    const advancedResult = await advanceRuns({
      scopeUserId,
      runId,
      budgetMs: 40_000,
      maxRuns: runId ? 1 : 4,
    });
    return NextResponse.json({ ok: true, expired, ...planned, ...advancedResult });
  } catch (e) {
    reportError('autopilot:tick', e);
    return NextResponse.json(
      { ok: false, error: 'tick_failed', message: e instanceof Error ? e.message : 'Autopilot tick failed' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

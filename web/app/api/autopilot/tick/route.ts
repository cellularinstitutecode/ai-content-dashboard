// web/app/api/autopilot/tick/route.ts
// The Autopilot heartbeat. Called two ways:
//   1. Vercel Cron (daily, see vercel.json) with Authorization: Bearer CRON_SECRET
//      → plans upcoming runs for ALL users and advances due ones.
//   2. A signed-in user ("Run engine now" button) → same, scoped to that user.
// Steps are idempotent and resumable, so overlapping or repeated ticks are safe.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { advanceRuns, expireStaleRuns, rescueStrandedApprovals, planRuns } from '@/lib/autopilot';
import { reportError } from '@/lib/report';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// 300, not 60. This route runs THREE phases and only budgeted the third, so the
// clock it was sized against was never the clock it actually ran on — see the
// note on the budget below. /api/videos/watch has declared 300 on this same
// plan since the video work and deploys fine.
export const maxDuration = 300;

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
  // The budget has to span the REQUEST, not just the last phase of it.
  //
  // 40_000 was measured from the moment advanceRuns was called, after planRuns
  // and expireStaleRuns had already spent an unknown amount of the 60s ceiling.
  // And advanceRuns only checks its deadline at loop boundaries, while a single
  // step is very heavy — stepResearch alone makes two Semrush calls, several
  // database reads and an assistant call in sequence. A step entered with one
  // second left still runs to completion, or to the platform killing the
  // process mid-write.
  //
  // So: start the clock at the top, give the advance phase whatever is actually
  // left, and keep a floor so a slow planning phase cannot hand it a budget too
  // small to finish even one step honestly.
  const started = Date.now();
  try {
    const planned = await planRuns(scopeUserId);
    const expired = await expireStaleRuns(scopeUserId);
    // Runs whose approval was killed mid-flight. `approved` is claimed before
    // the expensive work and released only by a thrown error, so a platform kill
    // leaves the run somewhere nothing else selects.
    const rescued = await rescueStrandedApprovals(scopeUserId);
    const remaining = 300_000 - (Date.now() - started);
    // 45s of headroom for the step in flight to finish and write back.
    //
    // Math.min, not a bare floor. The old `Math.max(40_000, remaining - 45_000)`
    // handed advanceRuns 40s even when `remaining` was NEGATIVE — turning "too
    // little budget left" into "guaranteed kill mid-write", which is the worse
    // of the two. Below the floor there is genuinely no time to start a step, so
    // the honest answer is zero and advanceRuns stops before it begins.
    const usable = remaining - 45_000;
    const advanceBudget = usable < 40_000 ? 0 : usable;
    if (advanceBudget === 0) {
      console.warn('autopilot:tick — planning and expiry used the whole budget; no runs advanced this tick.');
    }
    const advancedResult = await advanceRuns({
      scopeUserId,
      runId,
      budgetMs: advanceBudget,
      maxRuns: runId ? 1 : 4,
    });
    return NextResponse.json({ ok: true, expired, rescued, ...planned, ...advancedResult });
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

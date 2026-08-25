// web/app/api/autopilot/tick/route.ts
// The Autopilot heartbeat. Called two ways:
//   1. Vercel Cron (daily, see vercel.json) with Authorization: Bearer CRON_SECRET
//      → plans upcoming runs for ALL users and advances due ones.
//   2. A signed-in user ("Run engine now" button) → same, scoped to that user.
// Steps are idempotent and resumable, so overlapping or repeated ticks are safe.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { advanceRuns, planRuns } from '@/lib/autopilot';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') || '';
  const isCron = Boolean(secret) && auth === 'Bearer ' + secret;

  let scopeUserId: string | undefined;
  if (!isCron) {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    scopeUserId = user.id;
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

  const planned = await planRuns(scopeUserId);
  const advancedResult = await advanceRuns({
    scopeUserId,
    runId,
    budgetMs: 40_000,
    maxRuns: runId ? 1 : 4,
  });

  return NextResponse.json({ ok: true, ...planned, ...advancedResult });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

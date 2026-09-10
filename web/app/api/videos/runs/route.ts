// web/app/api/videos/runs/route.ts
// What the video pipeline actually did, as opposed to what the sheet says.
//   GET  → the signed-in user's video rows, each with a plain-English situation
//   POST → { id, action: 'retry' } — hand a stopped row back to the queue
//
// The sheet's ESTADO IA column has been the only visible state, and it holds
// six fixed Spanish strings. The database knows how many attempts a row has
// had, what the error was, whether a run died holding it, and whether anything
// will ever pick it up again. None of that was reachable, so a row that had
// quietly retired looked identical to one still waiting its turn.
//
// This route never transcribes and never publishes. `retry` re-arms a row; the
// work itself happens in the sweep or through the assistant's retry tool.
import { NextRequest, NextResponse } from 'next/server';

import { requireAllowlistedUser } from '@/lib/auth';
import { summarise } from '@/lib/assistant-context';
import { listRuns, getRun, rearmRun } from '@/lib/video-runs';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('limit') || '60', 10) || 60, 1), 200);

  try {
    const rows = await listRuns(auth.userId, limit);
    const snapshot = summarise(rows, Date.now());
    return NextResponse.json(
      {
        ok: true,
        counts: snapshot.counts,
        problems: snapshot.problems,
        rows: rows.map((r) => ({
          id: r.id,
          tab: r.tab,
          row: r.row_number,
          title: r.video_title,
          state: r.state,
          attempts: r.attempts,
          lastError: r.last_error,
          lastErrorCode: r.last_error_code ?? null,
          draftId: r.draft_id,
          keywords: r.keywords,
          ref: r.ref,
          updatedAt: r.updated_at,
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    // A read that cannot happen must not look like an empty pipeline.
    reportError('videos:runs-get', e);
    return NextResponse.json(
      { ok: false, error: 'unreadable', message: 'The video pipeline records could not be read just now.' },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit(auth.userId, 'video-prepare');
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
  }

  const body = await req.json().catch(() => null) as { id?: string; action?: string } | null;
  const id = String(body?.id || '').trim();
  const action = String(body?.action || '').trim();
  if (!id) return NextResponse.json({ error: 'bad_request', message: 'Which row?' }, { status: 400 });
  if (action !== 'retry') {
    return NextResponse.json({ error: 'bad_action', message: 'The only action here is "retry".' }, { status: 400 });
  }

  const run = await getRun(auth.userId, id);
  if (!run) return NextResponse.json({ error: 'not_found', message: 'No such video row.' }, { status: 404 });

  const ok = await rearmRun(auth.userId, run.id);
  if (!ok) {
    return NextResponse.json(
      { error: 'not_rearmed', message: 'That row could not be put back in the queue.' },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, id: run.id, state: 'discovered' }, { headers: { 'cache-control': 'no-store' } });
}

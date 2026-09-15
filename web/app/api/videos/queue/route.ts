// POST /api/videos/queue
//
// Queue ONE sheet row whose copy is already written: a dashboard draft, and
// Metricool drafts with the video attached, the copy exactly as the sheet has
// it. This is the "Attach videos" button's path for a row that has a video
// and copy but no draft yet — the sweep does the same thing on its own
// schedule (lib/video-autopilot.ts queueExistingCopy); this is the same code
// run now, for a row a person named.
//
// Body: { tab, row, publicationDate? } — publicationDate is a slot the batch
// plan reserved (/api/videos/batch), so a range of rows lands on distinct
// instants rather than one morning. Absent, the hand-off chooses the next
// free slot itself, as a single Prepare does.
//
// Same door as /api/videos/prepare: allowlisted, rate-limited. Nothing here
// publishes — every draft waits in Metricool review mode.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { queueExistingCopy } from '@/lib/video-autopilot';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// One Drive copy and a few Metricool calls — seconds, but a large video copy
// on Google's side can take a while to be acknowledged.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'video-prepare');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: { tab?: unknown; row?: unknown; publicationDate?: unknown } | null = null;
  try { body = await req.json(); } catch { body = null; }
  const tab = String(body?.tab || '').trim();
  const row = Number(body?.row);
  if (!tab || !Number.isInteger(row) || row < 2) {
    return NextResponse.json({ error: 'bad_row', message: 'Name the tab and a data row (2 or more).' }, { status: 400 });
  }
  const publicationDate = typeof body?.publicationDate === 'string' && body.publicationDate ? body.publicationDate : undefined;

  try {
    const out = await queueExistingCopy({ userId: auth.userId, tab, row, publicationDate, actor: publicationDate ? 'batch' : 'button' });
    if (!out.ok) {
      const status = out.reason === 'not_found' || out.reason === 'no_table' ? 404 : 422;
      return NextResponse.json({ error: out.reason, message: out.message }, { status });
    }
    return NextResponse.json({ ok: true, title: out.title, draftId: out.draftId, metricool: out.metricool }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    reportError('videos:queue', e, { tab, row: String(row) });
    return NextResponse.json(
      { error: 'queue_failed', message: e instanceof Error ? e.message : 'The row could not be queued just now.' },
      { status: 502 },
    );
  }
}

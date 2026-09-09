// POST /api/videos/batch/prepare-plan
//
// What a batch has to settle BEFORE any of its rows start, because both answers are
// wrong when several rows work them out at the same time:
//
//   1. The AI columns. ensureAiColumns reads the tab's width and appends what is
//      missing, with no lock. Two rows doing that at once give the tab two sets of
//      KEYWORDS/REF/ESTADO IA, and half the rows then write into the wrong one. Done
//      here, once per tab, serially.
//   2. The posting slots. Each row otherwise reads the calendar before any of them has
//      written to it, so they all pick the same morning and the batch lands stacked on
//      one instant. Reserved here from a single reading, one per row.
//
// Neither is work the browser could do for itself — both need the service account and
// the database — and neither is safe to leave to the rows.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { ensureTabColumns } from '@/lib/video-autopilot';
import { takenSlots } from '@/lib/video-publish';
import { reserveSlots } from '@/lib/video-slot';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// Reading a tab per distinct tab, plus one calendar read. Nothing here transcribes.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'video-prepare');
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
  }

  const body = await req.json().catch(() => ({}));
  const tabs = Array.isArray(body?.tabs) ? body.tabs.map((t: unknown) => String(t || '').trim()).filter(Boolean) : [];
  const count = Number(body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return NextResponse.json({ error: 'bad_count', message: 'Ask for between 1 and 200 slots.' }, { status: 400 });
  }

  // Serially, on purpose: doing these concurrently would be the very race this exists
  // to remove.
  const columnErrors: string[] = [];
  for (const tab of Array.from(new Set<string>(tabs)).slice(0, 20)) {
    try {
      await ensureTabColumns(tab);
    } catch (e) {
      reportError('videos:batch-columns', e, { tab });
      columnErrors.push(tab);
    }
  }

  let slots: string[] = [];
  try {
    const taken = await takenSlots(auth.userId, new Date().toISOString());
    slots = reserveSlots(count, taken).map((d) => d.toISOString());
  } catch (e) {
    // Not fatal. Without reserved slots each row falls back to choosing its own, which is
    // how a single Prepare has always worked — the batch just loses its guarantee that
    // they land on different mornings, and says so.
    reportError('videos:batch-slots', e);
  }

  return NextResponse.json({
    ok: true,
    slots,
    // Fewer slots than rows means the scheduling horizon ran out, not that anything failed.
    shortBy: Math.max(0, count - slots.length),
    columnErrors,
  }, { headers: { 'cache-control': 'no-store' } });
}

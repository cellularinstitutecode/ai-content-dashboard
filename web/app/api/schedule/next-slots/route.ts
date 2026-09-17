// GET /api/schedule/next-slots?n=3
//
// The next free posting slots on the clinic's planner — 08:00 and 17:00
// Cancún by default, skipping instants a post already holds — as UTC
// instants. The composer's time chips and the Prepare panel's default read
// this instead of computing "tomorrow 8 AM" on the browser's own clock,
// which on a UTC machine labelled 14:18 UTC as 2:18 PM Cancún.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { takenSlots } from '@/lib/video-publish';
import { reserveSlots } from '@/lib/video-slot';
import { SCHEDULE_TZ } from '@/lib/timezone';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const n = Math.min(6, Math.max(1, parseInt(req.nextUrl.searchParams.get('n') || '3', 10) || 3));
  try {
    const taken = await takenSlots(auth.userId, new Date().toISOString());
    const slots = reserveSlots(n, taken).map((d) => d.toISOString());
    return NextResponse.json({ ok: true, timezone: SCHEDULE_TZ, slots }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    reportError('schedule:next-slots', e);
    return NextResponse.json({ ok: false, error: 'slots_unavailable', message: 'The posting calendar could not be read just now.' }, { status: 503 });
  }
}

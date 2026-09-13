// web/app/api/videos/register/route.ts
// The video register: what has arrived, and what has happened to it.
//
//   GET               → the last N entries, newest first
//   GET ?videoKey=…   → everything that ever happened to one video
//
// Read-only. Nothing here writes, and the register has no write endpoint at all:
// entries are made by the code that does the work, through lib/video-register.ts,
// so a row in this table always corresponds to something that actually happened.
import { NextRequest, NextResponse } from 'next/server';

import { requireAllowlistedUser } from '@/lib/auth';
import { readRegister } from '@/lib/video-register';
import { describeEntry } from '@/lib/video-event';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '50', 10) || 50;
  const videoKey = req.nextUrl.searchParams.get('videoKey') || undefined;

  try {
    const out = await readRegister(auth.userId, { limit, videoKey });
    // `off` is not an error and not an empty register. It means the migration
    // has not been run, and the screen says so rather than showing a blank
    // panel that looks like "nothing has ever happened".
    if (out.off) {
      return NextResponse.json(
        {
          ok: true,
          off: true,
          message: 'The video register is not switched on yet. Run web/supabase/video-register.sql in Supabase to start recording.',
          entries: [],
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        off: false,
        entries: out.rows.map((r) => ({
          ...r,
          // Composed here, from the same map the rest of the app uses, so the
          // panel and any future reader cannot describe one event two ways.
          said: describeEntry(r),
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    // A read that cannot happen must not look like an empty register — the same
    // rule /api/videos/runs follows, for the same reason.
    reportError('videos:register-get', e);
    return NextResponse.json(
      { ok: false, error: 'unreadable', message: 'The video register could not be read just now.' },
      { status: 503 },
    );
  }
}

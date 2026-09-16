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
import { mergeRegisterFeed } from '@/lib/register-feed';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '50', 10) || 50;
  const videoKey = req.nextUrl.searchParams.get('videoKey') || undefined;

  // RUN LINES ARE READ SEPARATELY, and cannot spend the window.
  //
  // The sweep records a line every fifteen minutes whether or not it did
  // anything, so "the last forty entries" became forty sweep lines and nothing
  // else after ten quiet hours — and "Recently added" could only say that a
  // sweep had run. The activity keeps the whole limit; the latest run is one
  // extra row on top. A single video's history (?videoKey=) is unchanged:
  // there, every run line about it is the point.
  const RUN_EVENTS = ['sweep_ran'];

  try {
    const out = videoKey
      ? await readRegister(auth.userId, { limit, videoKey })
      : await (async () => {
        const [activity, runs] = await Promise.all([
          readRegister(auth.userId, { limit, except: RUN_EVENTS }),
          readRegister(auth.userId, { limit: 1, only: RUN_EVENTS }),
        ]);
        if (activity.off || runs.off) return { off: true } as const;
        return { off: false as const, rows: mergeRegisterFeed(activity.rows, runs.rows) };
      })();
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

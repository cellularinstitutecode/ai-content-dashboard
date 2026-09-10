// GET /api/media
//
// The videos a post can carry: the world-readable Drive copies already made by
// preparing a row. The composer and the calendar scheduler both read this to
// fill their "Attach a video" picker, and the Video Library matches a row's
// Drive file id against it so "Use in post" can bring the video along.
//
// Read-only by design. Nothing here creates a public copy of clinic footage —
// pressing Prepare on a row is the one action that does that.
import { NextRequest, NextResponse } from 'next/server';

import { requireAllowlistedUser } from '@/lib/auth';
import { listShareableVideos } from '@/lib/media-library';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // video_transcripts is a service-role cache keyed by video id, with no
  // user_id column — it is the clinic's shared library, not a per-person one.
  // The allowlist is therefore what scopes this, which is correct for a
  // single-clinic deployment and is worth stating rather than assuming.
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit(auth.userId, 'media-list');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '40', 10) || 40;

  try {
    const { videos, failed } = await listShareableVideos(limit);
    // "We could not read the library" and "the library is empty" send a person
    // to two completely different places, so they are never the same answer.
    return NextResponse.json(
      { ok: true, videos, failed },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    reportError('api:media-list', e);
    return NextResponse.json({ error: 'We could not read your video library just now.' }, { status: 500 });
  }
}

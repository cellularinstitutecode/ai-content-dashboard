// GET /api/media
//
// The videos a post can carry: the world-readable Drive copies already made by
// preparing a row. The composer and the calendar scheduler both read this to
// fill their "Attach a video" picker, and the Video Library matches a row's
// Drive file id against it so "Use in post" can bring the video along.
//
// GET is read-only: it lists videos that already have a shareable copy, and
// browsing never creates one. POST is the explicit opposite — it MAKES the copy
// for one named video, and is reached only from a button that says so.
import { NextRequest, NextResponse } from 'next/server';

import { requireAllowlistedUser } from '@/lib/auth';
import { ensureShareableVideo, listShareableVideos } from '@/lib/media-library';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// The POST copies a file inside Drive. That is server-side (files.copy), so a
// 1.7 GB reel never travels through this function — but a big file still takes
// Google a while, and 30s was the read's budget, not the copy's.
export const maxDuration = 60;
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

/**
 * POST /api/media  { videoLink, title? }
 *
 * Make this video attachable, and answer with the URL a post can carry.
 *
 * The read above only lists videos that already have a shareable copy, which
 * left "Use in post" on an unprepared row handing over the caption and nothing
 * else — indistinguishable, from the outside, from a broken button. This is the
 * explicit fix for that: the caller is a button that says it will make a
 * shareable copy, and the copy is made once per video and remembered.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  // The copy is a Drive write against the clinic's account. Capped tighter than
  // the read: nobody attaches two hundred different videos in an hour.
  const rl = await checkRateLimit(auth.userId, 'media-copy');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  let body: { videoLink?: unknown; title?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const videoLink = typeof body.videoLink === 'string' ? body.videoLink : '';
  const title = typeof body.title === 'string' ? body.title : '';
  if (!videoLink.trim()) {
    return NextResponse.json({ error: 'videoLink is required' }, { status: 400 });
  }

  try {
    const out = await ensureShareableVideo(videoLink, title);
    if (!out.ok) {
      return NextResponse.json({ error: out.message, reason: out.reason }, { status: out.reason === 'not_drive' ? 422 : 502 });
    }
    return NextResponse.json({ ok: true, url: out.url, fileId: out.fileId, created: out.created });
  } catch (e) {
    reportError('api:media-ensure', e);
    return NextResponse.json({ error: 'We could not prepare that video for posting just now.' }, { status: 500 });
  }
}

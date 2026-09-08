// POST /api/videos/prepare
// body: { url, transcript?, title?, youtubeUrl? }
//
// A produced video becomes publish-ready copy in one call: the words that were
// actually said — YouTube's caption track, or speech-to-text on the Drive
// .mp4 — → the Semrush keyword brief → Claude writes a LinkedIn post and a
// TikTok caption from the transcript, with the REF citation and the AVISO
// line → saved as a draft (kind: 'video') so it shows in Recent Drafts and can
// be edited. The work itself lives in lib/video-prepare.ts, which the
// automatic sweep also calls; this route is the human door onto it.
//
// The route never posts anything: sending to Metricool is a separate, explicit
// step from the Video Library, and Approve is still a person.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { isDriveUrl } from '@/lib/drive-url';
import { parseVideoUrl } from '@/lib/composer';
import { prepareVideo } from '@/lib/video-prepare';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// Speech-to-text on a Drive file is the slow step: the download and the
// transcription together can take well over the default 15s on a long video.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'generate');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  const url = String(body?.url || '').trim();
  const pasted = typeof body?.transcript === 'string' ? body.transcript.trim() : '';

  // A link this app can do something with: a YouTube video, or a Drive file it
  // can fetch. Anything else is refused here rather than deep in the ladder.
  const parsed = parseVideoUrl(url);
  const youtube = parsed.ok && parsed.source === 'YouTube';
  if (!youtube && !isDriveUrl(url)) {
    return NextResponse.json(
      { error: 'invalid_url', message: 'Paste a YouTube link or a Google Drive video link.' },
      { status: 400 },
    );
  }

  const out = await prepareVideo({
    userId: auth.userId,
    url,
    youtubeUrl: typeof body?.youtubeUrl === 'string' ? body.youtubeUrl : null,
    pasted,
    title: typeof body?.title === 'string' ? body.title : null,
  });

  if (!out.ok) {
    return NextResponse.json(
      { error: out.error, message: out.message, needsPaste: out.needsPaste, title: out.title },
      { status: out.status },
    );
  }

  return NextResponse.json({
    ok: true,
    draftId: out.draftId,
    title: out.title,
    videoId: out.videoId,
    transcript: { source: out.transcript.source, language: out.transcript.language, chars: out.transcript.chars, preview: out.transcript.preview },
    keywords: out.keywords,
    keywordLine: out.keywordLine,
    ref: out.ref,
    compliance: out.compliance,
    linkedin: out.linkedin,
    tiktok: out.tiktok,
  });
}

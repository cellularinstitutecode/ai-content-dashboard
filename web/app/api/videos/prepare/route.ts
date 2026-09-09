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
import { completeRow } from '@/lib/video-autopilot';
import { GoogleSourceError, serviceAccountEmail } from '@/lib/google-sources';
import { reportError } from '@/lib/report';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// Speech-to-text on a Drive file is the slow step: the download, the audio
// extraction and the transcription together run well past the default. 60 is
// the Hobby plan's ceiling and a deployment asking for more is rejected.
export const maxDuration = 60;

/**
 * What to actually DO about a failed sheet write.
 *
 * lib/google-error.ts already works out which of several very different
 * problems a Google refusal is, and the first 403 this hit surfaced as the
 * bare string "update row failed: HTTP 403" because the classification was
 * thrown away at the catch. A 403 on a write has one overwhelmingly likely
 * cause — the document is shared with the service account as Viewer, and
 * writing needs Editor — and reading access looks identical until something
 * tries to write, which is exactly why it goes unnoticed until this moment.
 */
function sheetWriteAdvice(e: unknown): string {
  if (!(e instanceof GoogleSourceError)) {
    return e instanceof Error ? e.message : 'Could not write that row.';
  }
  const who = serviceAccountEmail();
  if (e.reason === 'not_shared') {
    return 'Google refused the write. The sheet is shared with ' + (who || 'the dashboard’s service account') +
      ' as Viewer — writing needs Editor. Open the sheet, press Share, and change that address to Editor.';
  }
  if (e.reason === 'not_found') {
    return 'Google has no sheet with the id this dashboard is configured to write to. Check the id against the sheet’s URL.';
  }
  if (e.reason === 'bad_scopes' || e.reason === 'bad_credentials') {
    return 'Google rejected the dashboard’s credentials for this write. The service-account key needs re-issuing; no change to the sheet will help.';
  }
  if (e.reason === 'rate_limited') {
    return 'Google is rate-limiting the dashboard. This clears itself — press Prepare again in a minute.';
  }
  return e.message + (e.detail ? ' Google said: “' + e.detail.slice(0, 200) + '”' : '');
}

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

  // Pressed from a row in the Video Library? Then finish that row the way the
  // sweep finishes one: copy into column E, keywords and REF beside it, and
  // the drafts into Metricool. Without this the button produced copy and
  // stopped, so the same video handled by hand and handled automatically
  // ended up in two different states.
  let sheet: unknown = null;
  const tab = typeof body?.tab === 'string' ? body.tab : '';
  const row = Number(body?.row);
  if (tab && Number.isInteger(row) && row >= 2) {
    try {
      sheet = await completeRow({ userId: auth.userId, tab, row, prepared: out, videoLink: url });
    } catch (e) {
      // The copy is written and the draft is saved; only the hand-off failed.
      // Say so rather than losing the work behind a 500.
      reportError('videos:prepare-complete', e, { tab, row: String(row) });
      sheet = { error: sheetWriteAdvice(e) };
    }
  }

  return NextResponse.json({
    ok: true,
    sheet,
    draftId: out.draftId,
    title: out.title,
    videoId: out.videoId,
    transcript: { source: out.transcript.source, language: out.transcript.language, chars: out.transcript.chars, preview: out.transcript.preview },
    keywords: out.keywords,
    keywordLine: out.keywordLine,
    hasKeywords: out.hasKeywords,
    ref: out.ref,
    compliance: out.compliance,
    linkedin: out.linkedin,
    tiktok: out.tiktok,
  });
}

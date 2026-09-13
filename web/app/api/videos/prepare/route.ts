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
import { isDriveUrl, parseDriveFileId } from '@/lib/drive-url';
import { parseVideoUrl } from '@/lib/composer';
import { prepareVideo } from '@/lib/video-prepare';
import { completeRow, findRowByLink } from '@/lib/video-autopilot';
import { recordRowFailure } from '@/lib/video-runs';
import { cachedPublicCopy } from '@/lib/transcript-cache';
import { GoogleSourceError, serviceAccountEmail } from '@/lib/google-sources';
import { reportError } from '@/lib/report';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
// Speech-to-text on a Drive file is the slow step: the download, the audio
// extraction and the transcription together run well past the default.
//
// 60 was set on the belief that it was this plan's hard ceiling. It is not —
// /api/assistant has declared 300 since the Sources work and deploys fine, so
// the ceiling was never the constraint; the 60 simply guaranteed that a large
// reel could not finish in one press. 300 is the same number, from the same
// plan, applied where the slow work actually is.
export const maxDuration = 300;

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
  const rl = await checkRateLimit(auth.userId, 'video-prepare');
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
    // The platform kills the request at maxDuration, so the decision to stop
    // has to be made with room left to answer. This is the share of the clock
    // the work may use; the remainder is what answering costs.
    budgetMs: 280_000,
  });

  // Which row is this? Needed on BOTH paths now — the success path to write it,
  // and the failure path to record why it failed.
  let sheet: unknown = null;
  let tab = typeof body?.tab === 'string' ? body.tab : '';
  let row = Number(body?.row);

  if (!out.ok) {
    // Write the failure down before answering.
    //
    // video_runs was only ever written when a Prepare SUCCEEDED, so a failed
    // press left no trace anywhere but that browser's local storage. The
    // assistant then reported a healthy pipeline while videos sat broken, the
    // overnight pass had no row to revive, and the only way to learn what went
    // wrong was to press the button again and watch it fail.
    //
    // Best-effort on purpose: a bookkeeping write must never turn a 422 the
    // caller can act on into a 500 it cannot.
    if (tab && Number.isInteger(row) && row >= 2) {
      try {
        await recordRowFailure({
          userId: auth.userId,
          tab,
          row,
          videoLink: url,
          title: out.title,
          message: out.message,
          code: out.error,
          needsPaste: out.needsPaste,
        });
      } catch (e) {
        reportError('videos:prepare-record-failure', e, { tab, row: String(row) });
      }
    }
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

  // A link PASTED into the box carries no row, and until now that meant the
  // copy was written perfectly and put nowhere — the one step of this job that
  // was being automated. The link itself says which row it came from, so look
  // it up rather than making the person press the button on the right line.
  if (!(tab && Number.isInteger(row) && row >= 2)) {
    try {
      const found = await findRowByLink(url);
      if (found) { tab = found.tab; row = found.row; }
    } catch (e) {
      // Not being able to find the row is not a reason to lose the copy; the
      // response still carries it, and the panel says it was not written.
      reportError('videos:prepare-locate', e);
    }
  }

  if (tab && Number.isInteger(row) && row >= 2) {
    try {
      sheet = await completeRow({
        userId: auth.userId, tab, row, prepared: out, videoLink: url,
        // Given by a batch that reserved one slot per row from a single reading of the
        // calendar. Absent for a single Prepare, which chooses its own as it always has.
        publicationDate: typeof body?.publicationDate === 'string' ? body.publicationDate : undefined,
        // A reserved slot is what a BATCH sends; a single Prepare chooses its
        // own. That is already the difference between the two, so the register
        // can tell them apart without a new flag.
        actor: typeof body?.publicationDate === 'string' ? 'batch' : 'button',
        // Write the sheet, queue nothing.
        //
        // completeRow has always supported this and the door never opened it, so there
        // was no way to run thirty rows and read the copy before any of it reached a
        // posting queue — and no way to avoid the public Drive copy a video-needing
        // network requires, which nothing in this app can delete. The row's own Send
        // buttons still work afterwards.
        skipMetricool: body?.skipMetricool === true,
      });
    } catch (e) {
      // The copy is written and the draft is saved; only the hand-off failed.
      // Say so rather than losing the work behind a 500.
      reportError('videos:prepare-complete', e, { tab, row: String(row) });
      sheet = { error: sheetWriteAdvice(e) };
    }
  } else {
    sheet = { error: 'That link is not in the sheet, so there is no row to write the copy into. Press Prepare on the row itself to have it written back.' };
  }

  // The panel's own Send buttons attach the video, and the only URL a network
  // can actually open is the world-readable copy completeRow makes in Drive —
  // the source file is private. It is cached per Drive file id, so reading it
  // back here costs a lookup and never a second copy. Null when the row was
  // prepared with skipMetricool (no copy was made) or when the source is a
  // YouTube link, which needs none.
  let mediaUrl: string | null = null;
  try {
    const fileId = parseDriveFileId(url);
    if (fileId) mediaUrl = (await cachedPublicCopy(fileId))?.url || null;
  } catch (e) {
    // Bookkeeping: without it the buttons send text, which is the old behaviour.
    reportError('videos:prepare-media', e);
  }

  return NextResponse.json({
    ok: true,
    sheet,
    mediaUrl,
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

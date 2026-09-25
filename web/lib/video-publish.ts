// web/lib/video-publish.ts
// Putting a prepared video's copy into Metricool's REVIEW queue.
//
// The last step of the sweep, and the one that finishes the loop the team
// asked for: a link lands in the sheet and a post is waiting for approval in
// Metricool, written from what the video actually says.
//
// It reuses lib/metricool.ts's scheduler exactly as Autopilot does, in
// The mode comes from lib/publish-mode.ts: 'scheduled' by default, so the
// post lands on Metricool's calendar ready to go out at its slot, or 'review'
// when PUBLISH_MODE says so, in which case it is a draft awaiting approval.
// Nothing here can publish; 'scheduled' mode is reachable only from a person
// pressing Approve in the dashboard, and this is not that path.
//
// The compliance gate runs first, per network. Instagram and Facebook copy
// must carry the AVISO line and a REF citation, and a post that fails is not
// sent at all rather than sent for a person to notice.
import 'server-only';

import { complianceGate } from '@/lib/compliance-gate';
import { MediaNotNormalisedError, metricoolConfigured, metricoolSchedulePost, readPostId, type Provider } from '@/lib/metricool';
import { publishMode } from '@/lib/publish-mode';
import { preflightPost } from '@/lib/post-preflight';
import type { PackLike } from '@/lib/video-required';
import { youtubeDataFor } from '@/lib/youtube-meta';
import { tiktokDataFor } from '@/lib/tiktok-meta';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type PublishOne = {
  userId: string;
  network: string;
  text: string;
  /** UTC instant, ISO. */
  publicationDate: string;
  mediaUrl?: string | null;
  /**
   * The Drive file id behind mediaUrl, when that URL is a public copy this app made.
   *
   * Recorded so the copy can be removed once nothing needs it. One copy backs every
   * network of a run, so the delete has to be able to ask whether any other post still
   * uses it — which is impossible if the id is never written down.
   */
  mediaFileId?: string | null;
  draftId?: string | null;
  /** The video's title, for YouTube's own title field. */
  title?: string | null;
  /** The sheet's FORMATO cell, so a vertical clip is uploaded as a Short. */
  format?: string | null;
  /** The sheet's YOUTUBE cell — sometimes the word "Unlisted" rather than a link. */
  sheetYoutube?: string | null;
  /**
   * The linked draft's pack, so the "written from a video" rule can run HERE.
   *
   * It used to run only on Approve. Posts no longer wait for Approve, so
   * without this a LinkedIn post of transcript-written copy whose video copy
   * had failed published itself, text-only, at its slot.
   */
  pack?: PackLike;
};

export type PublishOutcome = {
  network: string;
  ok: boolean;
  metricoolPostId?: string | null;
  /** False when Metricool took the post but the `posts` row could not be written — the guard cannot see it. */
  recorded?: boolean;
  /** Why it was not sent — a compliance refusal reads differently from an outage. */
  reason?: 'not_configured' | 'compliance' | 'metricool_error' | 'too_long' | 'already_queued' | 'already_published' | 'media_unverified' | 'no_video' | 'needs_media' | 'wrong_aspect' | 'past'
    /** The video is still uploading into Metricool; this network's draft is owed and made on a later pass. */
    | 'upload_pending';
  message?: string;
};

export async function publishVideoDraft(input: PublishOne): Promise<PublishOutcome> {
  const network = String(input.network || '').toLowerCase();
  if (!metricoolConfigured()) {
    return { network, ok: false, reason: 'not_configured', message: 'Metricool is not configured on this deployment.' };
  }

  const gate = await complianceGate(input.userId, input.text, network);
  if (!gate.ok) {
    // Deliberately not sent. Copy missing the AVISO line or the REF citation
    // must not go out at all, and now goes out by itself if it does.
    return { network, ok: false, reason: 'compliance', message: gate.message };
  }

  // Everything else a post has to be right about, in the one place both doors
  // share (lib/post-preflight.ts). This used to be scattered: the video rule
  // lived only on Approve, which posts no longer pass through, and a supplied
  // publishing time was taken on trust here however far in the past it was.
  const pre = preflightPost({
    network,
    text: input.text,
    pack: input.pack ?? null,
    hasMedia: Boolean(String(input.mediaUrl || '').trim()),
    format: input.format,
    publicationDate: undefined,
    publishAt: input.publicationDate,
  } as Parameters<typeof preflightPost>[0]);
  if (!pre.ok) return { network, ok: false, reason: pre.reason, message: pre.message };

  try {
    const created = await metricoolSchedulePost({
      text: input.text,
      providers: [network as Provider],
      publicationDate: input.publicationDate,
      media: input.mediaUrl ? [{ url: input.mediaUrl }] : [],
      // YouTube refuses to save a draft with no title and no stated audience,
      // so a YouTube post that omits these is not a draft anybody can approve
      // — it is four fields of homework left on someone's desk.
      youtubeData: network === 'youtube'
        ? youtubeDataFor({
            title: input.title,
            body: input.text,
            format: input.format,
            sheetYoutube: input.sheetYoutube,
            defaultPrivacy: process.env.YOUTUBE_DEFAULT_PRIVACY,
          })
        : null,
      // TikTok: public, comments/duet/stitch on — a direct publication rather
      // than Metricool's "finish on your phone" mode.
      tiktokData: network === 'tiktok' ? tiktokDataFor({ title: input.title, body: input.text }) : null,
    }, publishMode());
    const metricoolPostId = readPostId(created);

    // Bookkeeping, so the dashboard's queue and calendar show this post like
    // any other — and THE ONLY THING THE DUPLICATE GUARD CAN SEE. Metricool
    // already holds the post; lib/awaiting-posts.ts decides "already sent" by
    // reading THIS row. A row that failed to write leaves the video looking
    // unsent, and the next pass — a revive, Attach videos, a person pressing
    // Send — posts it again. Metricool has no idempotency key. So the insert is
    // tried three times, and when it still fails the outcome says so
    // (recorded: false) and the register names the network, instead of one
    // reportError nobody reads until the video is on YouTube twice.
    let recorded = false;
    for (let attempt = 0; attempt < 3 && !recorded; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      try {
      const { error } = await supabaseAdmin().from('posts').insert({
        user_id: input.userId,
        draft_id: input.draftId || null,
        providers: [network],
        text: input.text,
        publication_date: input.publicationDate,
        metricool_post_id: metricoolPostId,
        // The public Drive copy this post's video came from, so the copy can be removed
        // once nothing needs it. Nothing on a posts row said anything about the video
        // before this, so every copy ever made was untraceable and permanent.
        media_drive_file_id: input.mediaFileId || null,
        // Metricool answers 'scheduled' for a post it is merely HOLDING for
        // review. Storing that verbatim would make our row claim a person had
        // approved something nobody has looked at.
        status: 'pending_review',
      });
      if (error) throw error;
      recorded = true;
      } catch (e) {
        reportError('video-publish:posts-insert', e, { network, attempt: String(attempt + 1), metricoolPostId: String(metricoolPostId || '') });
      }
    }

    return { network, ok: true, metricoolPostId, recorded };
  } catch (e) {
    if (e instanceof MediaNotNormalisedError) {
      // Not sent, on purpose: a draft that looks finished and goes out with no
      // video is the failure this whole path exists to prevent.
      return { network, ok: false, reason: 'media_unverified', message: e.message };
    }
    reportError('video-publish:schedule', e, { network });
    return { network, ok: false, reason: 'metricool_error', message: e instanceof Error ? e.message : 'Metricool did not accept the post.' };
  }
}

/** Instants already spoken for, so the slot chooser does not stack posts. */
export async function takenSlots(userId: string, fromIso: string): Promise<string[]> {
  // A failure here is worse than it looks. Returning [] does not mean "no
  // slots taken", it means "I could not find out" — and the slot chooser reads
  // the two the same way, so every post in the run lands on the same instant.
  // supabase-js RESOLVES a failed query, so the try/catch this had never fired
  // and the error was discarded unread.
  const r = await supabaseAdmin()
    .from('posts')
    .select('publication_date')
    .eq('user_id', userId)
    .gte('publication_date', fromIso)
    .limit(500)
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (r.error) {
    reportError('video-publish:taken-slots', r.error, { userId });
    throw new Error('Could not read the posting calendar, so a free slot cannot be chosen safely: ' + (r.error.message || 'unknown error'));
  }
  return ((r.data as { publication_date?: string }[] | null) || [])
    .map((x) => String(x.publication_date || ''))
    .filter(Boolean);
}

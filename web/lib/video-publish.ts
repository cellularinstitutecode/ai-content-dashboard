// web/lib/video-publish.ts
// Putting a prepared video's copy into Metricool's REVIEW queue.
//
// The last step of the sweep, and the one that finishes the loop the team
// asked for: a link lands in the sheet and a post is waiting for approval in
// Metricool, written from what the video actually says.
//
// It reuses lib/metricool.ts's scheduler exactly as Autopilot does, in
// 'review' mode — the post is a DRAFT that a person approves in Metricool.
// Nothing here can publish; 'scheduled' mode is reachable only from a person
// pressing Approve in the dashboard, and this is not that path.
//
// The compliance gate runs first, per network. Instagram and Facebook copy
// must carry the AVISO line and a REF citation, and a post that fails is not
// sent at all rather than sent for a person to notice.
import 'server-only';

import { complianceGate } from '@/lib/compliance-gate';
import { metricoolConfigured, metricoolSchedulePost, readPostId, type Provider } from '@/lib/metricool';
import { youtubeDataFor } from '@/lib/youtube-meta';
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
};

export type PublishOutcome = {
  network: string;
  ok: boolean;
  metricoolPostId?: string | null;
  /** Why it was not sent — a compliance refusal reads differently from an outage. */
  reason?: 'not_configured' | 'compliance' | 'metricool_error' | 'too_long';
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
    // must not sit in a queue where one wrong click publishes it.
    return { network, ok: false, reason: 'compliance', message: gate.message };
  }

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
    }, 'review');
    const metricoolPostId = readPostId(created);

    // Bookkeeping, so the dashboard's queue and calendar show this post like
    // any other. Best-effort: the draft is already in Metricool either way.
    try {
      await supabaseAdmin().from('posts').insert({
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
    } catch (e) { reportError('video-publish:posts-insert', e); }

    return { network, ok: true, metricoolPostId };
  } catch (e) {
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

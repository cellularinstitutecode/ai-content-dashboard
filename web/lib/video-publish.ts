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
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type PublishOne = {
  userId: string;
  network: string;
  text: string;
  /** UTC instant, ISO. */
  publicationDate: string;
  mediaUrl?: string | null;
  draftId?: string | null;
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
  try {
    const { data } = await supabaseAdmin()
      .from('posts')
      .select('publication_date')
      .eq('user_id', userId)
      .gte('publication_date', fromIso)
      .limit(500);
    return ((data as { publication_date?: string }[] | null) || [])
      .map((r) => String(r.publication_date || ''))
      .filter(Boolean);
  } catch (e) {
    reportError('video-publish:taken-slots', e);
    return [];
  }
}

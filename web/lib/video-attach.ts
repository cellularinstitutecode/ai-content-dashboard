// web/lib/video-attach.ts
// Attach a row's video to the drafts that are waiting for it — the PENDING
// chip's action, as a library call the sweep can make on its own.
//
// THE GAP. A row prepared before the Shared Drive existed has drafts in
// Metricool with no video: the copy could not be made then, so the post
// went out to the queue text-only and the publishing list shows PENDING.
// The sweep treated such a row as finished (state 'prepared') and walked
// past it every run, so those drafts stayed video-less until a person
// pressed the chip — one post at a time. "Attach the videos to every draft
// from row 179 onward" cannot mean that.
//
// Same steps as PATCH /api/posts { action: 'attach_video' }: make (or reuse)
// the world-readable copy, record it on the post, and REPLACE the Metricool
// post with the media attached — in the post's own mode, so a draft stays a
// draft. Attaching is not approving.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { ensureShareableVideo } from '@/lib/media-library';
import { metricoolReplacePost, normalizeMediaList, type Provider } from '@/lib/metricool';
import { normalizeFailure } from '@/lib/media-normalize-reason';
import { youtubeDataFor } from '@/lib/youtube-meta';
import { tiktokDataFor } from '@/lib/tiktok-meta';
import { isAwaitingApproval, modeOfStatus } from '@/lib/post-mode';
import { reportError } from '@/lib/report';
import { recordVideoEvent } from '@/lib/video-register';
import type { VideoActor } from '@/lib/video-event';

type PendingPost = {
  id: string;
  metricool_post_id: string | null;
  text: string | null;
  providers: string[] | null;
  publication_date: string | null;
  status: string | null;
};

export type AttachResult = {
  /** Drafts of this row that were waiting for the video before this call. */
  pending: number;
  attached: number;
  failed: number;
  /** Set when the copy itself could not be made — nothing was attached. */
  error?: string;
};

/**
 * The row's posts that still lack a video: awaiting approval, in Metricool,
 * and with no media_drive_file_id. Read-only; the sweep's dry run uses it.
 */
export async function pendingVideoPosts(userId: string, draftId: string): Promise<PendingPost[]> {
  const { data, error } = await supabaseAdmin()
    .from('posts')
    .select('id, metricool_post_id, text, providers, publication_date, status')
    .eq('user_id', userId)
    .eq('draft_id', draftId)
    .is('media_drive_file_id', null)
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (error) {
    reportError('video-attach:read', error, { draftId });
    return [];
  }
  return ((data || []) as PendingPost[]).filter((p) => p.metricool_post_id && isAwaitingApproval(p.status));
}

/**
 * Attach the video to every draft of `draftId` that is waiting for it.
 *
 * One copy per video (made or reused), one Metricool replace per post. A
 * post that cannot be updated is reported and left as it was — PENDING —
 * rather than marked attached. Never throws.
 */
export async function attachPendingVideos(args: {
  userId: string;
  draftId: string;
  videoKey: string;
  videoLink: string;
  title: string;
  actor: VideoActor;
  /** Register coordinates, so the line carries the row. */
  where?: Record<string, unknown>;
  /** What is left of the caller's clock: a big upload stops before it, with its progress banked. */
  budgetMs?: number;
}): Promise<AttachResult> {
  const posts = await pendingVideoPosts(args.userId, args.draftId);
  if (!posts.length) return { pending: 0, attached: 0, failed: 0 };

  const made = await ensureShareableVideo(args.videoLink, args.title, { userId: args.userId, actor: args.actor, budgetMs: args.budgetMs });
  if (!made.ok) return { pending: posts.length, attached: 0, failed: posts.length, error: made.message };

  // Metricool discards a media URL it has not normalised, silently and with a
  // 200 — so the list goes through the same step the approve path uses. A URL
  // it did not take is NOT sent as a fallback: that produced drafts that read
  // as attached and went out with no video.
  const norm = await normalizeMediaList([made.url]);
  // `failure`, not `degraded` — see normalizeMediaList on METRICOOL_ACCEPT_ECHO.
  if (norm.failure || !norm.media.length) {
    // Named, not just reported. This runs unattended in the sweep, so the one
    // record of what happened is the register entry written below — and "did
    // not take it" told a person nothing they could act on days later.
    const failure = normalizeFailure({ status: norm.failure?.status ?? null, error: norm.failure?.error ?? null, shape: norm.failure?.shape ?? null, attempts: norm.failure?.attempts ?? null, echoed: norm.failure?.echoed ?? null });
    const error = failure.message + ' Nothing was attached \u2014 the drafts still wait for it.';
    void recordVideoEvent({
      userId: args.userId, videoKey: args.videoKey, event: 'copy_failed', actor: args.actor, title: args.title, link: args.videoLink,
      detail: { ...(args.where || {}), reason: 'media_unverified', cause: failure.reason, status: String(failure.status ?? ''), error, copyId: made.fileId },
    });
    return { pending: posts.length, attached: 0, failed: posts.length, error };
  }
  const media = norm.media;

  // The sheet's FORMATO / YOUTUBE cells, from the draft's pack, so the
  // replace says Short-or-video the way the first hand-off did.
  const { data: draftRow } = await supabaseAdmin().from('drafts').select('pack').eq('id', args.draftId).maybeSingle()
    .then((x) => x, () => ({ data: null }));
  const packMeta = ((draftRow as { pack?: Record<string, unknown> | null } | null)?.pack || {}) as { format?: unknown; sheetYoutube?: unknown; title?: unknown };
  const metaTitle = typeof packMeta.title === 'string' ? packMeta.title : args.title;

  let attached = 0;
  let failed = 0;
  let lastError = '';
  for (const post of posts) {
    const text = String(post.text || '');
    const providers = (post.providers || []) as Provider[];
    const isYoutube = providers.some((p) => String(p).toLowerCase() === 'youtube');
    try {
      await metricoolReplacePost(String(post.metricool_post_id), {
        text,
        providers,
        publicationDate: String(post.publication_date || ''),
        media,
        // The post's OWN mode: a draft stays a draft. Attaching is not approving.
        mode: modeOfStatus(post.status),
        youtubeData: isYoutube
          ? youtubeDataFor({
              title: metaTitle,
              body: text,
              format: typeof packMeta.format === 'string' ? packMeta.format : null,
              sheetYoutube: typeof packMeta.sheetYoutube === 'string' ? packMeta.sheetYoutube : null,
              defaultPrivacy: process.env.YOUTUBE_DEFAULT_PRIVACY,
            })
          : null,
        tiktokData: providers.some((p) => String(p).toLowerCase() === 'tiktok') ? tiktokDataFor({ title: metaTitle, body: text }) : null,
      });
      const { error: linkError } = await supabaseAdmin()
        .from('posts')
        .update({ media_drive_file_id: made.fileId })
        .eq('id', post.id)
        .eq('user_id', args.userId)
        .then((x) => x, (e: unknown) => ({ error: e as { message?: string } }));
      if (linkError) {
        // Metricool has the video; the dashboard would still show PENDING.
        // Reported, and counted as a failure so a person looks.
        reportError('video-attach:link', linkError, { postId: post.id });
        failed++;
        lastError = 'The copy reached Metricool but could not be recorded on the post.';
        continue;
      }
      attached++;
    } catch (e) {
      reportError('video-attach:replace', e, { postId: post.id });
      failed++;
      lastError = e instanceof Error ? e.message : 'Metricool did not accept the update.';
    }
  }

  void recordVideoEvent({
    userId: args.userId,
    videoKey: args.videoKey,
    event: 'video_attached',
    actor: args.actor,
    title: args.title,
    link: args.videoLink,
    detail: { ...(args.where || {}), attached, failed, ...(lastError ? { error: lastError } : {}), copyId: made.fileId },
  });
  return { pending: posts.length, attached, failed, ...(lastError && !attached ? { error: lastError } : {}) };
}

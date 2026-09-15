// web/lib/awaiting-posts.ts
// The posts a video already has in the queue — the read half of the rule in
// lib/queue-guard.ts ("one draft per video and network while it waits").
//
// A video is known to the queue two ways: by its public copy, stamped on
// every post that carries it (media_drive_file_id), and by the drafts written
// from it (drafts.pack.videoId). Both are read, because a draft made before
// the copy existed has posts with no copy id, and a composer post has no
// draft. Never throws: a queue that cannot be read must cost a duplicate,
// not the hand-off.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';
import type { AwaitingLike } from '@/lib/queue-guard';

export type AwaitingPost = AwaitingLike & { id: string; draft_id: string | null; media_drive_file_id: string | null };

export async function awaitingPostsForVideo(userId: string, video: { fileId?: string | null; copyId?: string | null }): Promise<AwaitingPost[]> {
  const fileId = String(video.fileId || '').trim();
  const copyId = String(video.copyId || '').trim();
  if (!userId || (!fileId && !copyId)) return [];
  const admin = supabaseAdmin();

  const draftIds: string[] = [];
  if (fileId) {
    const { data, error } = await admin
      .from('drafts')
      .select('id')
      .eq('user_id', userId)
      .eq('pack->>videoId', fileId)
      .limit(50)
      .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
    if (error) reportError('awaiting-posts:drafts', error, { fileId });
    for (const d of (data || []) as { id: string }[]) if (d.id) draftIds.push(String(d.id));
  }

  const clauses: string[] = [];
  if (copyId) clauses.push('media_drive_file_id.eq.' + copyId);
  if (draftIds.length) clauses.push('draft_id.in.(' + draftIds.join(',') + ')');
  if (!clauses.length) return [];

  const { data, error } = await admin
    .from('posts')
    .select('id, providers, status, draft_id, media_drive_file_id')
    .eq('user_id', userId)
    .or(clauses.join(','))
    .limit(200)
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (error) {
    reportError('awaiting-posts:posts', error, { fileId, copyId });
    return [];
  }
  return (data || []) as AwaitingPost[];
}

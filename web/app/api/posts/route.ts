// web/app/api/posts/route.ts
import { complianceGate, gateRefusal } from '@/lib/compliance-gate';
import { recordApproval } from '@/lib/approval-log';
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { metricoolDeletePost, metricoolReplacePost, normalizeMediaList, type Provider } from '@/lib/metricool';
import { youtubeDataFor } from '@/lib/youtube-meta';
import { cachedPublicCopy } from '@/lib/transcript-cache';
import { reportError } from '@/lib/report';
import { deleteDriveFile } from '@/lib/drive';
import { forgetPublicCopy } from '@/lib/transcript-cache';
import { modeOfStatus, APPROVED_STATUS } from '@/lib/post-mode';

export const runtime = 'nodejs';
// Both mutating paths now make an upstream Metricool call before they touch the
// local row, so the default 10s budget is too tight.
// Two sequential Metricool calls now — normalise, then replace — each with its
// own timeout. 30 was the budget for one.
export const maxDuration = 60;

// GET /api/posts
// Returns the current user's scheduled posts, most recent publication first.
export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await sb
    .from('posts')
    .select('*')
    .eq('user_id', user.id)
    .order('publication_date', { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ posts: data ?? [] });
}

// PATCH /api/posts
//
// Three things a reviewer can do to a post, all of them in Metricool FIRST and
// in our own row only if Metricool agreed — so the two sides can never disagree:
//
//   { id, publication_date }        move it (stays in whichever queue it is in)
//   { id, action: 'approve' }       review queue → live queue; Metricool
//                                   publishes it at its publication_date
//   { id, action: 'publish_now' }   same, dated a couple of minutes from now
//
// `approve` is the only path in the whole app by which a post goes out, and it
// is reachable only from a button a signed-in reviewer pressed after reading
// the post. Every automated path (generator, calendar, templates, assistant,
// Autopilot) still ends in the review queue.
//
// Metricool's update is a REPLACE: the post's text, networks AND media have to
// be sent back with every change. Media is not on our `posts` row; it is the
// hero image on the linked draft, so it is looked up there — the reschedule
// path used to omit it, and a moved post silently lost its picture.
const PUBLISH_NOW_LEAD_MS = 2 * 60 * 1000;

// Which queue a post is in, and therefore whether a replace may carry
// draft:false/autoPublish:true. One rule, one home, one test — see
// lib/post-mode.ts for why 'scheduled' is not it.

export async function PATCH(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const id = body && body.id;
  const action: string = typeof body?.action === 'string' ? body.action : 'reschedule';
  const publicationDate = body && body.publication_date;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }
  if (!['reschedule', 'approve', 'publish_now'].includes(action)) {
    return NextResponse.json({ error: 'invalid_request', message: 'That is not something a post can do.' }, { status: 400 });
  }
  if (action === 'reschedule') {
    if (!publicationDate || typeof publicationDate !== 'string') {
      return NextResponse.json({ error: 'publication_date is required' }, { status: 400 });
    }
    if (isNaN(new Date(publicationDate).getTime())) {
      return NextResponse.json({ error: 'publication_date must be a valid ISO date' }, { status: 400 });
    }
  }

  const { data: existing, error: findErr } = await sb
    .from('posts')
    .select('id, metricool_post_id, text, providers, publication_date, status, draft_id, media_drive_file_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: 'post not found' }, { status: 404 });

  // The media travels with every replace, because a replace REPLACES: whatever
  // is not sent is removed from the post.
  //
  // Only the linked draft's IMAGE was ever looked up here, so approving a video
  // post stripped the video — the one thing the post existed to carry. The
  // video's world-readable copy is recoverable from the row's own
  // media_drive_file_id, which video-publish writes for exactly this reason.
  let media: string[] = [];
  if (existing.draft_id) {
    const { data: d } = await sb
      .from('drafts').select('pack').eq('id', existing.draft_id).eq('user_id', user.id).maybeSingle();
    const url = (d as any)?.pack?._image?.url;
    const textInImage = (d as any)?.pack?._image?.verification?.textDetected === true;
    if (typeof url === 'string' && url && !textInImage) media = [url];
  }
  if (!media.length && existing.media_drive_file_id) {
    try {
      const copy = await cachedPublicCopy(String(existing.media_drive_file_id));
      if (copy?.url) media = [copy.url];
    } catch (e) {
      // Losing the video on an approve is bad; failing the approve is worse.
      reportError('posts:media-lookup', e);
    }
  }
  // Metricool discards a media URL it has not normalised, silently and with a
  // 200 — so a list that skipped this step is the same as no list at all.
  if (media.length) {
    const norm = await normalizeMediaList(media);
    media = norm.media;
    if (norm.degraded) console.error('posts:media-not-normalised — this replace will drop the attachment');
  }

  // YouTube's own fields have to be re-sent for the same reason the media does.
  const isYoutube = ((existing.providers || []) as string[]).some((p) => String(p).toLowerCase() === 'youtube');
  const youtubeData = isYoutube
    ? youtubeDataFor({ body: String(existing.text || ''), defaultPrivacy: process.env.YOUTUBE_DEFAULT_PRIVACY })
    : null;

  // What the post will look like after this call.
  let nextDate: string = String(existing.publication_date || '');
  let nextStatus: string | null = null;
  let mode: 'review' | 'scheduled' = modeOfStatus(existing.status);

  if (action === 'reschedule') {
    nextDate = publicationDate;
  } else {
    if (mode === 'scheduled') {
      return NextResponse.json(
        { error: 'already_scheduled', message: 'This post is already approved and scheduled.' },
        { status: 409 },
      );
    }
    if (!existing.metricool_post_id) {
      return NextResponse.json(
        { error: 'not_in_metricool', message: 'This post was never sent to Metricool, so there is nothing to approve. Send it for review first.' },
        { status: 409 },
      );
    }
    if (action === 'publish_now') {
      nextDate = new Date(Date.now() + PUBLISH_NOW_LEAD_MS).toISOString();
    } else if (new Date(nextDate).getTime() <= Date.now()) {
      // Metricool refuses a past date, and would say so in its own words.
      // Say it in ours, before spending the call.
      return NextResponse.json(
        { error: 'date_passed', message: 'That date has already passed. Reschedule the post first, then approve it.' },
        { status: 409 },
      );
    }
    // The last door before a live post: Instagram / Facebook copy must carry
    // the advertising notice and a scientific reference.
    const gate = await complianceGate(user.id, String(existing.text || ''), (existing.providers || []) as string[]);
    if (!gate.ok) return NextResponse.json(gateRefusal(gate), { status: 422 });
    mode = 'scheduled';
    nextStatus = APPROVED_STATUS;
  }

  if (existing.metricool_post_id) {
    try {
      await metricoolReplacePost(String(existing.metricool_post_id), {
        text: String(existing.text || ''),
        providers: (existing.providers || []) as Provider[],
        publicationDate: nextDate,
        media,
        mode,
        youtubeData,
      });
    } catch (e) {
      reportError(action === 'reschedule' ? 'posts:metricool-reschedule' : 'posts:metricool-approve', e);
      return NextResponse.json(
        {
          error: 'metricool_update_failed',
          message: action === 'reschedule'
            ? 'We could not move this post in Metricool, so it has been left where it was. Open it in Metricool to change the time there.'
            : 'Metricool did not accept the approval, so the post is still waiting for review. Nothing was scheduled — try again in a moment.',
        },
        { status: 502 },
      );
    }
  }

  const patch: Record<string, unknown> = { publication_date: nextDate };
  if (nextStatus) patch.status = nextStatus;
  const { data, error } = await sb
    .from('posts')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .single();
  // PGRST116 = "no (or multiple) rows returned": the post belongs to someone
  // else or was deleted. The calendar used to report this as a 500.
  if (error && (error as any).code === 'PGRST116') {
    return NextResponse.json({ error: 'post not found' }, { status: 404 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // An approved post is also written to the team's calendar sheet, so the
  // sheet stays the record without anyone retyping. Best-effort: the post is
  // already approved in Metricool, so a sheet hiccup is reported, not fatal.
  if (nextStatus) {
    void recordApproval({
      publishDate: nextDate,
      networks: (existing.providers || []) as string[],
      caption: String(existing.text || ''),
      mediaUrl: media[0] || '',
      source: action === 'publish_now' ? 'Dashboard · publish now' : 'Dashboard · approve',
      postId: id,
    });
  }
  return NextResponse.json({ post: data });
}

// DELETE /api/posts?id=...
//
// There was no delete at all, which is how a single mis-click on "Apply
// template" could put weeks of posts on the calendar that no screen in the app
// could remove. Deleting removes the Metricool copy first (a post Metricool no
// longer has counts as already deleted) and only then drops the local row, so a
// failure here never leaves an orphan live in Metricool.
export async function DELETE(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data: existing, error: findErr } = await sb
    .from('posts')
    .select('id, metricool_post_id, media_drive_file_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: 'post not found' }, { status: 404 });

  if (existing.metricool_post_id) {
    try {
      await metricoolDeletePost(String(existing.metricool_post_id));
    } catch (e) {
      reportError('posts:metricool-delete', e);
      return NextResponse.json(
        {
          error: 'metricool_delete_failed',
          message: 'We could not remove this post from Metricool, so nothing was deleted. Try again, or delete it in Metricool.',
        },
        { status: 502 },
      );
    }
  }

  const { data: removed, error } = await sb
    .from('posts')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // RLS refuses a delete by returning zero rows, not an error. Without the
  // "posts: owner delete" policy from supabase/schema.sql this route would
  // report success while deleting nothing - say so instead of lying.
  if (!removed || removed.length === 0) {
    return NextResponse.json(
      {
        error: 'delete_blocked',
        message: 'The database refused the delete. Re-run supabase/schema.sql so the posts delete policy exists, then try again.',
      },
      { status: 500 },
    );
  }
  // The public Drive copy, once nothing needs it.
  //
  // A video attached to a post is copied into the app's folder and that copy is opened to
  // ANYONE with the link. One copy backs every network of a run, so deleting it with the
  // first post would break the others — hence the count. And deliberately AFTER the row
  // is gone: the handler above can delete the Metricool post and then fail to delete the
  // row, and destroying the file in that window would strand a post that still exists.
  //
  // Best-effort, and never fatal: an orphaned file is a tidiness problem, while a 500
  // here would tell a person their post was not deleted when it was.
  const copyId = (existing as { media_drive_file_id?: string | null }).media_drive_file_id;
  if (copyId) {
    try {
      const { count, error: countErr } = await sb
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('media_drive_file_id', copyId);
      // Only when the answer is a confident zero. A failed count must leave the file
      // alone: guessing wrong here breaks a post that is still queued.
      if (!countErr && (count ?? 1) === 0) {
        await deleteDriveFile(String(copyId));
        await forgetPublicCopy(String(copyId));
      }
    } catch (e) {
      reportError('posts:drive-copy-delete', e);
    }
  }

  return NextResponse.json({ ok: true, id });
}

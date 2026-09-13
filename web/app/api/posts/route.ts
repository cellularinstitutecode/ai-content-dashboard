// web/app/api/posts/route.ts
import { complianceGate, gateRefusal } from '@/lib/compliance-gate';
import { videoVerdict, pendingRefusal, videoSourceOf, type PackLike } from '@/lib/video-required';
import { ensureShareableVideo } from '@/lib/media-library';
import { recordApproval } from '@/lib/approval-log';
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { isAllowedEmail } from '@/lib/access';
import { checkRateLimit } from '@/lib/rate-limit';
import { metricoolDeletePost, metricoolReplacePost, normalizeMediaList, type Provider } from '@/lib/metricool';
import { youtubeDataFor } from '@/lib/youtube-meta';
import { cachedPublicCopy } from '@/lib/transcript-cache';
import { reportError } from '@/lib/report';
import { deleteDriveFile } from '@/lib/drive';
import { forgetPublicCopy } from '@/lib/transcript-cache';
import { modeOfStatus, videoPending, APPROVED_STATUS } from '@/lib/post-mode';

export const runtime = 'nodejs';
// Both mutating paths now make an upstream Metricool call before they touch the
// local row, so the default 10s budget is too tight.
// Two sequential Metricool calls now — normalise, then replace — each with its
// own timeout. 30 was the budget for one.
export const maxDuration = 60;

/**
 * A valid session is the weaker question here.
 *
 * This route APPROVES posts into the clinic's live Metricool queue and DELETES
 * files from its Drive — the two most consequential things the app can do — and
 * it was the only route touching that shared account with no allowlist check
 * of its own. Every sibling carries one as a second copy of the middleware
 * rule, precisely because the middleware exemption has gone wrong before
 * (see lib/machine-auth.ts). Someone removed from ALLOWED_EMAILS but still
 * holding a live cookie could publish to the clinic's channels.
 *
 * Worse, the guard test built to catch exactly this
 * (lib/route-policy.test.ts) missed it: its "reaches the shared Metricool
 * account" pattern did not name metricoolReplacePost or metricoolDeletePost,
 * so this file passed a net designed around it. Both are in the pattern now.
 */
async function requireClinicUser(sb: Awaited<ReturnType<typeof supabaseServer>>) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { ok: false as const, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  if (!isAllowedEmail(user.email)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, user };
}

// GET /api/posts
// Returns the current user's scheduled posts, most recent publication first.
export async function GET() {
  const sb = await supabaseServer();
  const auth = await requireClinicUser(sb);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  // Reaches Metricool and Drive. Every other route that leaves the building is
  // capped; this one, which publishes and deletes, was not.
  const rl = await checkRateLimit(user.id, 'posts');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const { data, error } = await sb
    .from('posts')
    .select('*')
    .eq('user_id', user.id)
    .order('publication_date', { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // `videoPending` — the PENDING chip's whole input.
  //
  // ONE extra query for the page, not one per post. Provenance lives in
  // drafts.pack (there is no column for it anywhere), so the packs behind this
  // page's posts are fetched in a single `in(...)` and matched up in memory.
  // Whether the post has the video is answered by media_drive_file_id, which is
  // already on the row — so no Drive call and no Metricool call happen here.
  //
  // That is a slightly weaker question than the gate in PATCH asks: PATCH also
  // has to RESOLVE the copy through Drive, so a row pointing at a copy someone
  // has since deleted shows no chip here and is still refused there. The two
  // errors are not symmetric and this is the safe side of them — the chip can
  // be missing from a post that cannot go out, never present on one that can.
  const posts = (data ?? []) as Record<string, unknown>[];
  const draftIds = Array.from(
    new Set(posts.map((p) => String(p.draft_id || '')).filter(Boolean)),
  );
  const packs: Record<string, PackLike> = {};
  let packsUnavailable = false;
  if (draftIds.length) {
    const { data: ds, error: packErr } = await sb
      .from('drafts').select('id, pack').in('id', draftIds).eq('user_id', user.id);
    if (packErr) {
      // Said out loud rather than swallowed. Without the packs nothing can be
      // known to be video-derived, so every chip would be absent — which reads
      // as "nothing is pending" and is the opposite of the truth. The approve
      // gate in PATCH is unaffected either way; it reads the pack itself.
      reportError('posts:pack-read', packErr, { userId: user.id });
      packsUnavailable = true;
    }
    for (const d of ds || []) {
      packs[String((d as { id: string }).id)] = (d as { pack: PackLike }).pack ?? null;
    }
  }

  return NextResponse.json({
    posts: posts.map((p) => ({
      ...p,
      videoPending: packsUnavailable
        ? false
        : videoPending(p.status, packs[String(p.draft_id || '')] ?? null, Boolean(p.media_drive_file_id)),
    })),
    ...(packsUnavailable ? { packsUnavailable: true } : {}),
  });
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
  const auth = await requireClinicUser(sb);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  // Reaches Metricool and Drive. Every other route that leaves the building is
  // capped; this one, which publishes and deletes, was not.
  const rl = await checkRateLimit(user.id, 'posts');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

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
  if (!['reschedule', 'approve', 'publish_now', 'attach_video'].includes(action)) {
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

  // --- the linked draft, read ONCE -----------------------------------------
  //
  // Three things need this row and it used to be fetched twice: the hero image
  // that travels with every replace (a replace REPLACES — whatever is not sent
  // is removed from the post), the provenance that says whether this copy was
  // transcribed from a video, and the source link the attach button fetches
  // from. Two reads of one row can disagree; one cannot.
  let draftPack: Record<string, unknown> | null = null;
  let heroImage = '';
  if (existing.draft_id) {
    // The error is checked because a replace REPLACES. supabase-js RESOLVES a
    // failed read, so an ignored `error` gave `d = null`, an empty media list,
    // and a post published with its picture deleted — indistinguishable from a
    // draft that never had one. A video survives this through the
    // media_drive_file_id fallback below; an image has no second source, so
    // for images the failure was silent and permanent.
    const { data: d, error: draftError } = await sb
      .from('drafts').select('pack').eq('id', existing.draft_id).eq('user_id', user.id).maybeSingle();
    if (draftError) {
      reportError('posts:draft-media-read', draftError, { id });
      return NextResponse.json(
        {
          error: 'media_unreadable',
          message: 'We could not read this post’s draft, and going ahead now would send it without its picture or its video. Nothing was changed — try again in a moment.',
        },
        { status: 503 },
      );
    }
    draftPack = (d as any)?.pack ?? null;
    const url = (d as any)?.pack?._image?.url;
    const textInImage = (d as any)?.pack?._image?.verification?.textDetected === true;
    if (typeof url === 'string' && url && !textInImage) heroImage = url;
  }

  // --- attach_video: what the PENDING chip does ------------------------------
  //
  // Makes the world-readable copy the post needs and records it, then falls
  // through to the ordinary replace below so the video actually reaches
  // Metricool. Separate from `approve` on purpose: attaching is not approving,
  // and somebody fixing a post should be able to do the first without being
  // committed to the second.
  if (action === 'attach_video') {
    // No draft at all, or a draft that has forgotten its video: one refusal for
    // both, because from here they are the same thing — there is nothing to
    // fetch. (This is why the read above is not conditional on the action:
    // `.eq('id', '')` against a uuid column is a database ERROR, so a post that
    // simply never had a draft would have come back to a person as "we could
    // not read your draft".)
    const source = videoSourceOf(draftPack);
    if (!source) {
      return NextResponse.json(
        {
          error: 'no_source',
          message: 'This post’s draft does not record which video it came from, so there is nothing to attach. Re-prepare that row from the Video Library.',
        },
        { status: 422 },
      );
    }
    // The primitive already exists: rate-limited, allowlisted, budgeted, and it
    // writes copy_made / copy_failed to the video register either way.
    const made = await ensureShareableVideo(source, String((draftPack as { title?: unknown } | null)?.title ?? ''), {
      userId: user.id,
      actor: 'button',
    });
    if (!made.ok) {
      // copyFailureAdvice tells Google's five causes apart, and while the copies
      // folder is not in a Shared Drive this is where a person finally reads
      // that — per post, rather than as one global banner.
      return NextResponse.json({ error: made.code || 'copy_failed', message: made.message }, { status: 502 });
    }
    const { error: linkError } = await sb
      .from('posts')
      .update({ media_drive_file_id: made.fileId })
      .eq('id', id)
      .eq('user_id', user.id);
    if (linkError) {
      reportError('posts:attach-link', linkError, { id });
      return NextResponse.json(
        { error: 'not_linked', message: 'The copy was made, but we could not attach it to this post. Try again in a moment.' },
        { status: 503 },
      );
    }
    // Read back through the same field the rest of this handler uses, so the
    // replace below picks the video up exactly as an approve would.
    (existing as { media_drive_file_id?: string | null }).media_drive_file_id = made.fileId;
  }

  // Only the linked draft's IMAGE was ever looked up for this, so approving a
  // video post stripped the video — the one thing the post existed to carry.
  // The video's world-readable copy is recoverable from the row's own
  // media_drive_file_id, which video-publish writes for exactly this reason.
  let media: string[] = [];
  // Did the post resolve to THE VIDEO, as opposed to some attachment? The video
  // rule below needs that exact question answered and no looser one.
  let videoAttached = false;
  // THE VIDEO FIRST, and the order matters.
  //
  // media_drive_file_id only ever holds the world-readable copy of a video —
  // lib/video-publish.ts writes it, and so does attach_video above; no image
  // path touches that column. So when a row carries one, that is the thing the
  // post exists to deliver, and a hero image must not be sent in front of it.
  //
  // This used to read image-first, with the video as a fallback for posts that
  // had no image. That was correct only by accident: video-prepared packs carry
  // no _image today because ensureDraftImage is called from the Autopilot path
  // alone. The day a video draft acquired one — a regeneration, a merge, a hand
  // edit — approving it would have published the picture and silently dropped
  // the video, which is the exact failure the rule above exists to prevent.
  if (existing.media_drive_file_id) {
    try {
      const copy = await cachedPublicCopy(String(existing.media_drive_file_id));
      if (copy?.url) {
        media = [copy.url];
        videoAttached = true;
      }
    } catch (e) {
      // Losing the video on an approve is bad; failing the approve is worse.
      // The gate below still refuses the post, so this degrades to PENDING
      // rather than to a video-less publish.
      reportError('posts:media-lookup', e);
    }
  }
  if (!media.length && heroImage) media = [heroImage];
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
  } else if (action === 'attach_video') {
    // Attaching is NOT approving. The replace below carries the video to
    // Metricool and the post stays exactly where it was in the queue, waiting
    // for a person — which is the whole point of the rule.
    if (!existing.metricool_post_id) {
      return NextResponse.json(
        { error: 'not_in_metricool', message: 'This post was never sent to Metricool, so there is nothing to attach the video to. Send it for review first.' },
        { status: 409 },
      );
    }
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

    // And the video rule, at the same door rather than in a mechanism of its
    // own. Copy transcribed from a video may not go out without that video.
    //
    // `videoAttached`, not `media.length` — an image is an attachment and is not
    // the video, and asking the looser question would wave through precisely the
    // post this rule exists to stop.
    const verdict = videoVerdict(draftPack, videoAttached);
    if (verdict.pending) {
      return NextResponse.json(
        { error: 'video_pending', message: pendingRefusal(verdict), sourceUrl: verdict.sourceUrl },
        { status: 422 },
      );
    }
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
    // Awaited, for the reason lib/autopilot.ts records: on Vercel the lambda
    // can freeze once the response is returned, so a fire-and-forget insert is
    // lost non-deterministically. recordApproval is already fail-soft, so this
    // costs nothing. (The same construct was fixed in approveRun; leaving the
    // sibling half-done is how one of the two gates stays broken.)
    await recordApproval({
      publishDate: nextDate,
      networks: (existing.providers || []) as string[],
      caption: String(existing.text || ''),
      mediaUrl: media[0] || '',
      source: action === 'publish_now' ? 'Dashboard · publish now' : 'Dashboard · approve',
      postId: id,
    });
  }
  return NextResponse.json({
    post: data,
    // So the caller can tell the two apart without inspecting the row: an
    // attach leaves the post exactly where it was, waiting for a person.
    ...(action === 'attach_video' ? { attached: true, mediaUrl: media[0] || null } : {}),
  });
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
  const auth = await requireClinicUser(sb);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  // Reaches Metricool and Drive. Every other route that leaves the building is
  // capped; this one, which publishes and deletes, was not.
  const rl = await checkRateLimit(user.id, 'posts');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

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

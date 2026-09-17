import { reportError, redact } from '@/lib/report';
import { complianceGate, gateRefusal } from '@/lib/compliance-gate';
import { apiBase as metricoolApiBase, normalizeMediaList } from '@/lib/metricool';
import { bucketKeyFromUrl } from '@/lib/video-bucket';
import { streamCopyIdFromUrl } from '@/lib/media-url';
import { metricoolRefusal } from '@/lib/metricool-refusal';
import { youtubeDataFor } from '@/lib/youtube-meta';
import { tiktokDataFor } from '@/lib/tiktok-meta';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isAllowedEmail, ALLOWED_BLOG_IDS, DEFAULT_BLOG_ID } from '@/lib/access';
import { checkRateLimit } from '@/lib/rate-limit';
import { normalizePublishAt, METRICOOL_TIMEZONE } from '@/lib/metricool-time';
import { mediaProblem } from '@/lib/composer';
import { parseDriveFileId } from '@/lib/drive-url';
import { recordVideoEvent } from '@/lib/video-register';
import { videoKeyFor } from '@/lib/video-event';
import { rowKeyFor } from '@/lib/video-row';
import { SOURCE_IDS } from '@/lib/google-sources';
import { awaitingPostsForVideo } from '@/lib/awaiting-posts';
import { networksAlreadyPublished } from '@/lib/queue-guard';
import { decideAdoption } from '@/lib/adopt-draft';

export const runtime = 'nodejs';
// This route makes TWO sequential calls to Metricool now — normalise the media,
// then create the post — and normalising a large video is a file transfer, not
// a metadata lookup. With no maxDuration the platform default (10s) killed the
// request mid-normalise, so adding the media step would have turned a working
// button into an unexplained timeout on exactly the posts that carry video.
export const maxDuration = 60;

const NETWORK_MAP: Record<string, string> = {
  facebook: 'facebook',
  instagram: 'instagram',
  twitter: 'twitter',
  x: 'twitter',
  linkedin: 'linkedin',
  tiktok: 'tiktok',
  youtube: 'youtube',
  threads: 'threads',
};

// The wall-clock conversion now lives in lib/metricool-time.ts so the chat
// assistant shares it instead of carrying its own (buggy) copy, and so it can
// be unit-tested.
const TIMEZONE = METRICOOL_TIMEZONE;

// Which Metricool brand profiles this deployment may post into is defined once
// in lib/access.ts (ALLOWED_BLOG_IDS / DEFAULT_BLOG_ID) and shared with the read
// routes so the allowlist can't drift between endpoints.

// POST /api/metricool/schedule
// body: { network, text, publishAt (ISO datetime string), blogId?, mediaUrl?, draftId? }
//
// This route NEVER publishes. Everything it sends to Metricool is held as a
// draft for a human to approve there. That used to be a request parameter
// (`autoPublish`), which meant any signed-in caller could switch the review step
// off for themselves - the one control standing between generated copy and a
// medical clinic's live social accounts. Whether a post publishes is a property
// of this function, not of the request; a future "approve and publish" action
// belongs in its own route that reads an approval record from the database.
export async function POST(req: NextRequest) {
  // --- Auth guard (defense in depth; matches drafts/opus routes) ---
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Reaches a resource that belongs to the clinic, not to a user, so a valid
  // session is the weaker question. Middleware enforces this too; this is the
  // copy that stays correct if the middleware exemption ever widens again.
  if (!isAllowedEmail(user.email)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
      { status: 403 },
    );
  }

  // Scheduling reaches a paid third party and a live brand account. Capped like
  // every other route that leaves the building.
  const rl = await checkRateLimit(user.id, 'schedule');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const token = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID;
  if (!token || !userId) {
    return NextResponse.json({ error: 'METRICOOL_USER_TOKEN and METRICOOL_USER_ID must be configured' }, { status: 500 });
  }
  let payload: any;
  try { payload = await req.json(); } catch { payload = {}; }
  const network = String(payload.network || '').toLowerCase();
  const text = String(payload.text || '').trim();
  const when = normalizePublishAt(payload.publishAt);
  const blogId = String(payload.blogId || DEFAULT_BLOG_ID);
  const draftId = payload.draftId ? String(payload.draftId) : null;
  // Ownership, checked once here so the draft's pack can be read for the
  // YouTube/TikTok presets below; the row link further down reuses the answer.
  let ownedDraftIdEarly: string | null = null;
  if (draftId) {
    const { data: ownDraftEarly } = await sb.from('drafts').select('id').eq('id', draftId).eq('user_id', user.id).maybeSingle()
      .then((x) => x, () => ({ data: null }));
    ownedDraftIdEarly = ownDraftEarly ? draftId : null;
  }
  if (!when) return NextResponse.json({ error: 'publishAt must be a valid datetime' }, { status: 400 });
  // Metricool refuses a past date, but only when a person opens the draft and
  // tries to save it — by which point the post has been sitting in the queue
  // looking fine. Refuse it here, where the answer is still useful.
  if (Date.parse(when.instant) <= Date.now()) {
    return NextResponse.json(
      { error: 'That time has already passed. Pick a future date and time.' },
      { status: 422 },
    );
  }
  if (!ALLOWED_BLOG_IDS.has(blogId)) {
    return NextResponse.json({ error: 'Unknown brand profile' }, { status: 400 });
  }
  const publishAt = when.wallClock;
  const provider = NETWORK_MAP[network];
  if (!provider) return NextResponse.json({ error: 'Unsupported network: ' + network }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });

  // Instagram / Facebook copy must carry the advertising notice and a
  // scientific reference before it goes anywhere near the account.
  const gate = await complianceGate(user.id, text, network);
  if (!gate.ok) return NextResponse.json(gateRefusal(gate), { status: 422 });

  // AND THE MEDIA REQUIREMENT, on the server.
  //
  // mediaProblem existed only in the browser — app/page.tsx and
  // app/calendar/page.tsx — so this route accepted { network: 'tiktok',
  // text: '…' } with no mediaUrl and answered ok: true. The post then sat in
  // Metricool as something the network will refuse. A rule enforced only in the
  // page that happens to call it is not enforced.
  const needsMedia = mediaProblem([network], typeof payload.mediaUrl === 'string' ? payload.mediaUrl : '');
  if (needsMedia) {
    return NextResponse.json({ error: 'media_required', message: needsMedia }, { status: 422 });
  }

  // ONE DRAFT PER VIDEO AND NETWORK while it waits for approval — the same
  // rule the sweep's hand-off applies (lib/queue-guard.ts). A post carrying a
  // video that already has a draft on this network waiting in the queue is
  // refused with the row named, instead of becoming the fourth copy.
  // Set by the block below when this send should REPLACE a draft that is
  // already waiting, rather than create a second one.
  let adopt: { postId: string; metricoolPostId: string } | null = null;
  {
    // Three shapes of media URL now, and a streamed one identifies its video
    // by its path alone. Without this the column stayed null, so the duplicate
    // guard below never fired and a post that carries its video reported as
    // still waiting for one.
    const copyId = typeof payload.mediaUrl === 'string'
      ? (parseDriveFileId(payload.mediaUrl) || bucketKeyFromUrl(payload.mediaUrl) || streamCopyIdFromUrl(payload.mediaUrl))
      : null;
    const sourceId = typeof payload.sourceUrl === 'string' ? parseDriveFileId(payload.sourceUrl) : null;
    if (copyId || sourceId) {
      const already = await awaitingPostsForVideo(user.id, { fileId: sourceId, copyId });
      const rowNum = Number(payload.sheetRow);
      const rowLabel = typeof payload.sheetTab === 'string' && payload.sheetTab && Number.isInteger(rowNum) && rowNum >= 2 ? payload.sheetTab.trim() + ' \u00b7 row ' + rowNum : null;
      // Already published on this network: finished, and not sendable again by
      // hand either. Approving had emptied the waiting list, which is what made
      // a published row look free.
      const gone = networksAlreadyPublished(already, [network]);
      if (gone.published.length) {
        return NextResponse.json({
          error: 'already_published',
          message: (rowLabel || 'This video') + ' has already been published on ' + network + '. Posting it again would publish the same video twice \u2014 nothing was created.',
        }, { status: 409 });
      }
      // A DRAFT ALREADY WAITING IS THE DRAFT THIS SEND CONTINUES.
      //
      // This used to answer 409 "already has a draft waiting for your approval
      // — approve it in the queue, or delete it there first", which is a wall
      // in front of the one thing a person actually wants: to keep working on
      // that draft. The lookup is unchanged and still the reason one row
      // stopped reaching Metricool eleven times; only the answer moves, from
      // refusing to updating. lib/adopt-draft.ts holds the rule.
      const decision = decideAdoption(already, network);
      if (decision.action === 'update') {
        adopt = { postId: decision.postId, metricoolPostId: decision.metricoolPostId };
      }
    }
  }

  const body: any = {
    text: text,
    publicationDate: { dateTime: publishAt, timezone: TIMEZONE },
    providers: [{ network: provider }],
    // draft:true tells Metricool to hold the post for review rather than queue
    // it live. Both values are constants: see the note on POST above.
    autoPublish: false,
    draft: true,
  };
  if (payload.mediaUrl) {
    // Normalised first, and sent as a URL STRING.
    //
    // Both halves of that were wrong, and the effect was the same either way:
    // Metricool accepted the post with a 200 and quietly dropped the file, so
    // "attached" here meant nothing at all by the time a person opened the
    // draft and read "Add at least 1 image or video." A URL Metricool did not
    // take is refused here rather than sent for it to drop.
    const norm = await normalizeMediaList([String(payload.mediaUrl)]);
    if (norm.degraded || !norm.media.length) {
      return NextResponse.json(
        { error: 'media_unverified', message: 'Metricool did not take the video, so the post was not created. Try again in a moment; if it keeps happening, the video copy needs a look.' },
        { status: 422 },
      );
    }
    body.media = norm.media;
  }

  // The sheet's FORMATO / YOUTUBE cells: sent by the composer when the post
  // was handed over from a row, else read from the draft's pack (the Prepare
  // panel sends its draftId), so a vertical reel is a Short from every door.
  let sheetFormat = typeof payload.format === 'string' ? payload.format : '';
  let sheetYoutube = typeof payload.sheetYoutube === 'string' ? payload.sheetYoutube : '';
  let packTitle = '';
  if (ownedDraftIdEarly && (!sheetFormat || provider === 'youtube' || provider === 'tiktok')) {
    const { data: d } = await sb.from('drafts').select('pack').eq('id', ownedDraftIdEarly).eq('user_id', user.id).maybeSingle()
      .then((x) => x, () => ({ data: null }));
    const pack = ((d as { pack?: Record<string, unknown> | null } | null)?.pack || {}) as { format?: unknown; sheetYoutube?: unknown; title?: unknown };
    if (!sheetFormat && typeof pack.format === 'string') sheetFormat = pack.format;
    if (!sheetYoutube && typeof pack.sheetYoutube === 'string') sheetYoutube = pack.sheetYoutube;
    if (typeof pack.title === 'string') packTitle = pack.title;
  }
  const postTitle = (typeof payload.title === 'string' && payload.title.trim()) ? payload.title : packTitle;

  // TikTok: public, comments/duet/stitch on — a direct publication rather than
  // Metricool's "finish on your phone" mode.
  if (provider === 'tiktok') body.tiktokData = tiktokDataFor({ title: postTitle, body: text });

  // YouTube alone needs a title, a Short-or-video answer and a stated audience;
  // without them Metricool will not let the draft be saved, let alone approved.
  if (provider === 'youtube') {
    const yt = youtubeDataFor({
      title: postTitle,
      body: text,
      format: sheetFormat,
      sheetYoutube,
      defaultPrivacy: process.env.YOUTUBE_DEFAULT_PRIVACY,
    });
    if (!yt) {
      return NextResponse.json(
        { error: 'A YouTube post needs a title. Give the post a first line, or send it to the other networks.' },
        { status: 422 },
      );
    }
    body.youtubeData = yt;
  }

  // The same base every other Metricool call uses (lib/metricool.ts), so the
  // e2e harness can stand in for the scheduler here too. This route hard-coded
  // the production host, which is why the composer's own path was the one
  // door the mock could never watch.
  // CREATE, or REPLACE the draft that is already waiting.
  //
  // Metricool's own shape: POST /posts makes one, PUT /posts/<id> replaces one
  // WHOLE. Replace is what we want — the draft becomes exactly what the panel
  // is showing — and the body above is built identically either way, so the
  // copy, the video, the time, the YouTube Short type and the TikTok options
  // all carry across rather than being half-updated.
  const url = adopt
    ? metricoolApiBase() + '/v2/scheduler/posts/' + encodeURIComponent(adopt.metricoolPostId) + '?blogId=' + encodeURIComponent(blogId) + '&userId=' + encodeURIComponent(userId)
    : metricoolApiBase() + '/v2/scheduler/posts?blogId=' + encodeURIComponent(blogId) + '&userId=' + encodeURIComponent(userId);

  try {
    const r = await fetch(url, {
      method: adopt ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Mc-Auth': token,
      },
      body: JSON.stringify(body),
    });
    const rawText = await r.text();
    let parsed: any = null;
    try { parsed = JSON.parse(rawText); } catch { parsed = { raw: rawText }; }
    if (!r.ok) {
      // The body is still not forwarded — it is READ, here, and answered with
      // our own sentence.
      //
      // "Metricool rejected the request. Please review and try again." was the
      // entire account anybody got, and the composer then discarded even that,
      // so a network that failed because it is not CONNECTED read exactly like
      // one that failed because the video was too long. Three problems, three
      // different fixes, one word on screen. metricoolRefusal reads the body
      // where it already is and returns a sentence that cannot contain it.
      console.error('Metricool schedule error', r.status, redact(rawText.slice(0, 500)));
      return NextResponse.json(
        {
          error: 'metricool_refused',
          message: metricoolRefusal(r.status, rawText, network),
          status: r.status,
        },
        { status: 502 },
      );
    }
    const post = (parsed && parsed.data) ? parsed.data : parsed;
    const id = post && (post.id || post.postId) ? (post.id || post.postId) : null;
    // Metricool's word for the post, which is NOT our word for it. It answers
  // 'scheduled' for a post it is holding in its REVIEW queue, and storing that
  // verbatim made our own row claim a post had been approved when nobody had
  // looked at it. app/api/assistant/route.ts already guarded against this; this
  // path did not. Anything that would read as approved is stored as what it
  // actually is: waiting for review.
  const raw = (post && post.providers && post.providers[0] && post.providers[0].status) || null;
  const status = raw && String(raw).toLowerCase() !== 'scheduled' && String(raw).toLowerCase() !== 'approved'
    ? raw
    : null;
    const publicationDate = post && post.publicationDate ? post.publicationDate : null;
    const providers = post && post.providers ? post.providers : [];

    // --- Persist to posts table (best-effort; scheduling already succeeded) ---
    // `draft_id` is written with the service-role client, which bypasses RLS, so
    // an unowned id would happily attach this post to someone else's draft and
    // corrupt the drafts-to-posts join. Verify ownership first; an id that isn't
    // the caller's is dropped rather than rejected, because the post is already
    // scheduled and the link is bookkeeping.
    // Asked once, at the top of the handler, where the draft's pack is also
    // read for the YouTube/TikTok presets — the same question, one query.
    const ownedDraftId: string | null = ownedDraftIdEarly;
    if (draftId && !ownedDraftId) {
      console.warn('metricool/schedule: ignoring draftId not owned by caller');
    }
    // supabase-js RESOLVES a failed insert rather than throwing, so this catch
    // could never fire for a database error and the result was discarded
    // unread. The post is already live in Metricool at this point; without the
    // local row it appears on no calendar, and /api/posts cannot reschedule or
    // delete it — a post nobody can reach, reported as ok:true.
    let bookkeeping: string | null = null;
    try {
      const admin = supabaseAdmin();
      // The copy that went out with the post, when there was one: the queue
      // reads media_drive_file_id to know the post carries its video, and
      // lib/post-source.ts follows it back to the sheet row.
      const mediaCopyId = typeof payload.mediaUrl === 'string' ? (parseDriveFileId(payload.mediaUrl) || bucketKeyFromUrl(payload.mediaUrl) || streamCopyIdFromUrl(payload.mediaUrl)) : null;
      const row = {
        user_id: user.id,
        draft_id: ownedDraftId,
        providers: [provider],
        text: text,
        // Store the absolute instant, not the wall-clock string: the column is
        // timestamptz and the calendar reads it back as one.
        publication_date: when.instant,
        metricool_post_id: id,
        status: status || 'pending_review',
        ...(mediaCopyId ? { media_drive_file_id: mediaCopyId } : {}),
      };
      // The SAME row either way — written over the draft that was waiting, or
      // inserted as a new one. Scoped to the caller even though this is the
      // service-role client, which bypasses RLS: the id came from a lookup of
      // the caller's own posts, and an eq on user_id keeps it that way if that
      // ever stops being true.
      const { error: writeError } = adopt
        ? await admin.from('posts').update(row).eq('id', adopt.postId).eq('user_id', user.id)
        : await admin.from('posts').insert(row);
      if (writeError) throw writeError;
    } catch (err) {
      reportError(adopt ? 'schedule:posts-update' : 'schedule:posts-insert', err);
      // Said out loud rather than swallowed: the draft exists in Metricool and
      // this dashboard has no record of it, which is the one situation where a
      // person must go and look there instead of here.
      bookkeeping = 'The draft is in Metricool, but it could not be saved to this dashboard — it will not appear in your queue or calendar. Open it in Metricool to approve or remove it.';
    }

    // WHERE it came from. A post handed over from a sheet row carries the
    // row with it; said in the register, keyed like the sweep's own lines for
    // that row, so the queue can name the row and Recently added threads it.
    // Validated, not trusted: a tab name and a data row, with a Drive link.
    {
      const sheetTab = typeof payload.sheetTab === 'string' ? payload.sheetTab.trim().slice(0, 120) : '';
      const sheetRow = Number(payload.sheetRow);
      const sourceUrl = typeof payload.sourceUrl === 'string' ? payload.sourceUrl.trim().slice(0, 500) : '';
      const sheetId = SOURCE_IDS.videosSheet();
      if (sheetTab && Number.isInteger(sheetRow) && sheetRow >= 2 && parseDriveFileId(sourceUrl) && sheetId) {
        const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 200) : '';
        void recordVideoEvent({
          userId: user.id,
          videoKey: videoKeyFor(sheetId, sheetTab, rowKeyFor(title, sourceUrl)),
          event: 'queued',
          actor: 'button',
          title: title || null,
          link: sourceUrl,
          detail: { tab: sheetTab, row: sheetRow, networks: [provider], composer: true, metricoolId: id },
        }).catch((e: unknown) => reportError('schedule:register', e, { tab: sheetTab, row: String(sheetRow) }));
      }
    }

    return NextResponse.json({
      ok: true,
      // Which of the two happened. Without it the panel would say "saved" for
      // an update and leave a person wondering whether a second draft now
      // exists — the exact anxiety the old 409 was trying to prevent.
      updated: Boolean(adopt),
      ...(bookkeeping ? { warning: bookkeeping } : {}),
      id: id,
      status: status || 'pending_review',
      autoPublish: false,
      review: true,
      publicationDate: publicationDate,
      publishAtUtc: when.instant,
      timezone: TIMEZONE,
      providers: providers,
    });
  } catch (err: any) {
    const lastErr = err && err.message ? err.message : String(err);
    reportError('metricool:schedule', lastErr);
    return NextResponse.json({ error: 'Could not reach Metricool. Please try again.' }, { status: 502 });
  }
}

import { reportError, redact } from '@/lib/report';
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isAllowedEmail, ALLOWED_BLOG_IDS, DEFAULT_BLOG_ID } from '@/lib/access';
import { checkRateLimit } from '@/lib/rate-limit';
import { normalizePublishAt, METRICOOL_TIMEZONE } from '@/lib/metricool-time';

export const runtime = 'nodejs';

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
  if (!when) return NextResponse.json({ error: 'publishAt must be a valid datetime' }, { status: 400 });
  if (!ALLOWED_BLOG_IDS.has(blogId)) {
    return NextResponse.json({ error: 'Unknown brand profile' }, { status: 400 });
  }
  const publishAt = when.wallClock;
  const provider = NETWORK_MAP[network];
  if (!provider) return NextResponse.json({ error: 'Unsupported network: ' + network }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });

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
    body.media = [{ url: String(payload.mediaUrl) }];
  }

  const base = 'https://app.metricool.com';
  const url = base + '/api/v2/scheduler/posts?blogId=' + encodeURIComponent(blogId) + '&userId=' + encodeURIComponent(userId);

  try {
    const r = await fetch(url, {
      method: 'POST',
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
      // Do not leak the raw upstream body to the client; log it server-side instead.
      console.error('Metricool schedule error', r.status, redact(rawText.slice(0, 500)));
      return NextResponse.json({ error: 'Metricool rejected the request. Please review and try again.', status: r.status }, { status: 502 });
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
    let ownedDraftId: string | null = null;
    if (draftId) {
      const { data: ownDraft } = await sb
        .from('drafts')
        .select('id')
        .eq('id', draftId)
        .eq('user_id', user.id)
        .maybeSingle();
      ownedDraftId = ownDraft ? draftId : null;
      if (!ownedDraftId) {
        console.warn('metricool/schedule: ignoring draftId not owned by caller');
      }
    }
    try {
      const admin = supabaseAdmin();
      await admin.from('posts').insert({
        user_id: user.id,
        draft_id: ownedDraftId,
        providers: [provider],
        text: text,
        // Store the absolute instant, not the wall-clock string: the column is
        // timestamptz and the calendar reads it back as one.
        publication_date: when.instant,
        metricool_post_id: id,
        status: status || 'pending_review',
      });
    } catch (err) { /* logging-only */ reportError('schedule:posts-insert', err); }

    return NextResponse.json({
      ok: true,
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

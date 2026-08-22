import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';

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

const TIMEZONE = process.env.METRICOOL_TIMEZONE || 'America/Cancun';

// Metricool wants a WALL-CLOCK datetime plus the timezone it belongs to:
// { dateTime: 'YYYY-MM-DDTHH:MM:SS', timezone: TIMEZONE }.
//
// The previous implementation stripped a trailing `Z` (or a `±HH:MM` offset)
// and passed the remaining digits straight through, which silently
// reinterpreted a UTC instant as TIMEZONE local time. The calendar sends
// `Date.toISOString()`, so a post the user asked for at 09:00 local went out
// at 14:00 Cancun — five hours late — while the dashboard's naive
// `datetime-local` value happened to be right. Both callers are handled here:
//
//   • an absolute instant (ends in Z or an offset) is CONVERTED into
//     TIMEZONE wall-clock;
//   • a naive value is taken as already being TIMEZONE wall-clock.
//
// Returns null when the input is not a usable datetime at all.
function toZonedWallClock(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  // en-CA + hour12:false can render midnight as "24"; normalise it.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return get('year') + '-' + get('month') + '-' + get('day') + 'T' + hour + ':' + get('minute') + ':' + get('second');
}

function normalizePublishAt(input: string): { wallClock: string; instant: string } | null {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const absolute = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (absolute) {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return { wallClock: toZonedWallClock(d, TIMEZONE), instant: d.toISOString() };
  }

  let s = raw.replace(/\.\d+$/, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s = s + ':00';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;

  // Recover the absolute instant for the naive wall-clock by measuring the
  // zone's offset at that moment (handles DST without a tz database).
  const guess = new Date(s + 'Z');
  if (isNaN(guess.getTime())) return null;
  const offsetMs = new Date(toZonedWallClock(guess, TIMEZONE) + 'Z').getTime() - guess.getTime();
  return { wallClock: s, instant: new Date(guess.getTime() - offsetMs).toISOString() };
}

// Which Metricool brand profiles this deployment is allowed to post into. The
// shared org token can reach several, so the id is never taken on trust from
// the request body.
const DEFAULT_BLOG_ID = process.env.METRICOOL_BLOG_ID || '4308292';
const ALLOWED_BLOG_IDS = new Set(
  (process.env.METRICOOL_BLOG_IDS || DEFAULT_BLOG_ID)
    .split(',').map((x) => x.trim()).filter(Boolean)
);

// POST /api/metricool/schedule
// body: { network, text, publishAt (ISO datetime string), blogId?, mediaUrl?, draftId?, autoPublish? }
export async function POST(req: NextRequest) {
  // --- Auth guard (defense in depth; matches drafts/opus routes) ---
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

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

  // Review step: never auto-publish by default. Posts land in Metricool as
  // drafts/pending so a human approves them there before they go live. Callers
  // may opt in with { autoPublish: true } once a reviewer has approved.
  const autoPublish = payload.autoPublish === true;

  const body: any = {
    text: text,
    publicationDate: { dateTime: publishAt, timezone: TIMEZONE },
    providers: [{ network: provider }],
    // draft:true tells Metricool to hold the post for review rather than queue it live.
    autoPublish,
    draft: !autoPublish,
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
      console.error('Metricool schedule error', r.status, rawText.slice(0, 500));
      return NextResponse.json({ error: 'Metricool rejected the request. Please review and try again.', status: r.status }, { status: 502 });
    }
    const post = (parsed && parsed.data) ? parsed.data : parsed;
    const id = post && (post.id || post.postId) ? (post.id || post.postId) : null;
    const status = (post && post.providers && post.providers[0] && post.providers[0].status) || null;
    const publicationDate = post && post.publicationDate ? post.publicationDate : null;
    const providers = post && post.providers ? post.providers : [];

    // --- Persist to posts table (best-effort; scheduling already succeeded) ---
    try {
      const admin = supabaseAdmin();
      await admin.from('posts').insert({
        user_id: user.id,
        draft_id: draftId,
        providers: [provider],
        text: text,
        // Store the absolute instant, not the wall-clock string: the column is
        // timestamptz and the calendar reads it back as one.
        publication_date: when.instant,
        metricool_post_id: id,
        status: status || (autoPublish ? 'scheduled' : 'pending_review'),
      });
    } catch { /* logging-only */ }

    return NextResponse.json({
      ok: true,
      id: id,
      status: status || (autoPublish ? 'scheduled' : 'pending_review'),
      autoPublish,
      review: !autoPublish,
      publicationDate: publicationDate,
      publishAtUtc: when.instant,
      timezone: TIMEZONE,
      providers: providers,
      post: post,
    });
  } catch (err: any) {
    const lastErr = err && err.message ? err.message : String(err);
    console.error('Metricool schedule exception', lastErr);
    return NextResponse.json({ error: 'Could not reach Metricool. Please try again.' }, { status: 502 });
  }
}

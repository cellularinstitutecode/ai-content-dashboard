import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';

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

// Metricool requires ISO datetime with seconds: YYYY-MM-DDTHH:MM:SS
// datetime-local inputs in browsers produce YYYY-MM-DDTHH:MM (no seconds)
function normalizePublishAt(input: string): string {
  let s = String(input || '').trim();
  if (!s) return s;
  s = s.replace(/Z$/, '').replace(/[+-]\d{2}:?\d{2}$/, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s = s + ':00';
  s = s.replace(/\.\d+$/, '');
  return s;
}

// POST /api/metricool/schedule
// body: { network, text, publishAt (ISO datetime string), blogId?, mediaUrl?, draftId? }
export async function POST(req: NextRequest) {
  // --- Auth guard (defense in depth; matches drafts/opus routes) ---
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const token = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID || '3377431';
  if (!token) {
    return NextResponse.json({ error: 'METRICOOL_USER_TOKEN not configured' }, { status: 500 });
  }
  let payload: any;
  try { payload = await req.json(); } catch { payload = {}; }
  const network = String(payload.network || '').toLowerCase();
  const text = String(payload.text || '').trim();
  const publishAt = normalizePublishAt(payload.publishAt);
  const blogId = String(payload.blogId || '4308292');
  const draftId = payload.draftId ? String(payload.draftId) : null;
  if (!publishAt) return NextResponse.json({ error: 'publishAt is required (ISO datetime)' }, { status: 400 });
  const provider = NETWORK_MAP[network];
  if (!provider) return NextResponse.json({ error: 'Unsupported network: ' + network }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });

  const body: any = {
    text: text,
    publicationDate: { dateTime: publishAt, timezone: TIMEZONE },
    providers: [{ network: provider }],
    autoPublish: true,
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
      return NextResponse.json({ error: 'Metricool API error', status: r.status, detail: parsed, publishAtSent: publishAt }, { status: 502 });
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
        publication_date: publishAt,
        metricool_post_id: id,
        status: status || 'scheduled',
      });
    } catch { /* logging-only */ }

    return NextResponse.json({
      ok: true,
      id: id,
      status: status,
      publicationDate: publicationDate,
      providers: providers,
      post: post,
    });
  } catch (err: any) {
    const lastErr = err && err.message ? err.message : String(err);
    return NextResponse.json({ error: 'Metricool API error', detail: lastErr }, { status: 502 });
  }
}

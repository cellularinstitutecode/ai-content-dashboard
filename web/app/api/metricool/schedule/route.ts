import { NextRequest, NextResponse } from 'next/server';

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

// POST /api/metricool/schedule
// body: { network, text, publishAt (ISO datetime string), blogId?, mediaUrl? }
export async function POST(req: NextRequest) {
  const token = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID || '3377431';
  if (!token) {
    return NextResponse.json({ error: 'METRICOOL_USER_TOKEN not configured' }, { status: 500 });
  }
  let payload: any;
  try { payload = await req.json(); } catch { payload = {}; }
  const network = String(payload.network || '').toLowerCase();
  const text = String(payload.text || '').trim();
  const publishAt = String(payload.publishAt || '').trim();
  const blogId = String(payload.blogId || '4308292');
  if (!publishAt) return NextResponse.json({ error: 'publishAt is required (ISO datetime)' }, { status: 400 });
  const provider = NETWORK_MAP[network];
  if (!provider) return NextResponse.json({ error: 'Unsupported network: ' + network }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });

  const body: any = {
    text: text,
    publicationDate: { dateTime: publishAt, timezone: 'America/Cancun' },
    providers: [{ network: provider }],
    autoPublish: true,
  };
  if (payload.mediaUrl) {
    body.media = [{ url: String(payload.mediaUrl) }];
  }

  const base = 'https://app.metricool.com';
  const candidates = [
    base + '/api/v2/scheduler/posts?blogId=' + encodeURIComponent(blogId) + '&userId=' + encodeURIComponent(userId),
  ];

  let lastErr: any = null;
  for (const url of candidates) {
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
        lastErr = { url: url, status: r.status, body: parsed };
        continue;
      }
      // Metricool wraps the scheduled post in { data: {...} } - unwrap it
      const post = (parsed && parsed.data) ? parsed.data : parsed;
      const id = post && (post.id || post.postId) ? (post.id || post.postId) : null;
      const status = (post && post.providers && post.providers[0] && post.providers[0].status) || null;
      const publicationDate = post && post.publicationDate ? post.publicationDate : null;
      const providers = post && post.providers ? post.providers : [];
      return NextResponse.json({
        ok: true,
        id: id,
        status: status,
        publicationDate: publicationDate,
        providers: providers,
        post: post,
      });
    } catch (err: any) {
      lastErr = { url: url, error: err && err.message ? err.message : String(err) };
    }
  }
  return NextResponse.json({ error: 'Metricool API error', detail: lastErr }, { status: 502 });
}

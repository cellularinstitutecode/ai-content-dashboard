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
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (!publishAt) return NextResponse.json({ error: 'publishAt is required (ISO datetime)' }, { status: 400 });
  const provider = NETWORK_MAP[network];
  if (!provider) return NextResponse.json({ error: 'unknown network: ' + network }, { status: 400 });
  const d = new Date(publishAt);
  if (isNaN(d.getTime())) {
    return NextResponse.json({ error: 'invalid publishAt' }, { status: 400 });
  }
  const isoLocal = d.toISOString().slice(0, 19);

  // Minimal ScheduledPost shape that Metricool v2 accepts.
  const body: any = {
    text,
    publicationDate: { dateTime: isoLocal, timezone: 'America/Cancun' },
    providers: [{ network: provider }],
    autoPublish: true,
  };
  if (payload.mediaUrl) {
    body.media = [{ url: String(payload.mediaUrl) }];
  }

  const url = 'https://app.metricool.com/api/v2/scheduler/posts?blogId=' + blogId + '&userId=' + userId;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'X-Mc-Auth': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let resp: any;
    try { resp = JSON.parse(txt); } catch { resp = { raw: txt.slice(0, 800) }; }
    if (r.ok) {
      return NextResponse.json({ ok: true, id: resp && (resp.id || resp.postId) ? (resp.id || resp.postId) : null, response: resp });
    }
    return NextResponse.json({ error: (resp && (resp.detail || resp.title)) || 'Metricool rejected the request', status: r.status, sent: body, response: resp }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e && e.message ? e.message : 'network error' }, { status: 500 });
  }
}

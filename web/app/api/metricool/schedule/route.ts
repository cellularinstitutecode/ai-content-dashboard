import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Map UI network value to Metricool provider name.
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
  const mediaUrl = payload.mediaUrl ? String(payload.mediaUrl) : '';
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (!publishAt) return NextResponse.json({ error: 'publishAt is required (ISO datetime)' }, { status: 400 });
  const provider = NETWORK_MAP[network];
  if (!provider) return NextResponse.json({ error: 'unknown network: ' + network }, { status: 400 });

  // Metricool expects publicationDate as { dateTime, timezone }
  const d = new Date(publishAt);
  if (isNaN(d.getTime())) {
    return NextResponse.json({ error: 'invalid publishAt' }, { status: 400 });
  }
  const isoLocal = d.toISOString().slice(0, 19);

  const body = {
    text,
    publicationDate: { dateTime: isoLocal, timezone: 'America/Cancun' },
    providers: [{ network: provider }],
    autoPublish: true,
    draft: false,
    media: mediaUrl ? [{ url: mediaUrl }] : [],
    smartLinks: [],
    info: {},
  };

  const base = 'https://app.metricool.com/api';
  const qs = 'blogId=' + blogId + '&userId=' + userId;
  const candidates = [
    base + '/v2/scheduler/posts?' + qs,
    base + '/v1/scheduler/posts?' + qs,
    base + '/scheduler/posts?' + qs,
  ];
  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'X-Mc-Auth': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      let resp: any;
      try { resp = JSON.parse(txt); } catch { resp = { raw: txt.slice(0, 800) }; }
      attempts.push({ url, status: r.status, ok: r.ok, response: resp });
      if (r.ok) {
        return NextResponse.json({ ok: true, endpoint: url, id: resp && (resp.id || resp.postId) ? (resp.id || resp.postId) : null, response: resp });
      }
    } catch (e: any) {
      attempts.push({ url, error: e && e.message ? e.message : String(e) });
    }
  }
  return NextResponse.json({ error: 'All Metricool scheduler endpoints rejected the request', sent: body, attempts }, { status: 502 });
}

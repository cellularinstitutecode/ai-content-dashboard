import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// GET /api/metricool?blogId=4308292
// Returns the latest analytics summary for the given Metricool brand.
export async function GET(req: NextRequest) {
  const token = process.env.METRICOOL_USER_TOKEN;
  const userId = process.env.METRICOOL_USER_ID || '3377431';
  if (!token) {
    return NextResponse.json({ error: 'METRICOOL_USER_TOKEN not configured' }, { status: 500 });
  }
  const blogId = req.nextUrl.searchParams.get('blogId') || '4308292';
  const today = new Date();
  const start = new Date(today.getTime() - 30 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://app.metricool.com/api/stats/competitors?start=${fmt(start)}&end=${fmt(today)}&blogId=${blogId}&userId=${userId}`;
  try {
    const r = await fetch(url, { headers: { 'X-Mc-Auth': token } });
    const text = await r.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 2000) }; }
    if (!r.ok) {
      return NextResponse.json({ error: 'Metricool API error', status: r.status, body }, { status: r.status });
    }
    return NextResponse.json({ blogId, userId, range: { start: fmt(start), end: fmt(today) }, data: body });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Network error' }, { status: 500 });
  }
}

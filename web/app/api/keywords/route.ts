// web/app/api/keywords/route.ts
// Server-side Semrush keyword lookup for the Keyword Intelligence panel.
// The Semrush API key stays on the server (read from env), never exposed to the
// browser. Returns normalized keyword metrics for a topic.
import { NextRequest, NextResponse } from 'next/server';
import { researchKeywords } from '@/lib/keywords';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const topic = (req.nextUrl.searchParams.get('topic') || req.nextUrl.searchParams.get('kw') || '').trim();

  // Diagnostics mode: /api/keywords?diag=1 reports whether the integration is
  // wired up WITHOUT exposing the token value. Safe to call to debug the
  // 'still says not set' situation after configuring Vercel env vars.
  if (req.nextUrl.searchParams.get('diag')) {
    const hasKey = Boolean(process.env.SEMRUSH_API_KEY);
    const hasDatabase = Boolean(process.env.SEMRUSH_DATABASE);
    let probe: unknown = null;
    if (hasKey) {
      // Live round-trip against Semrush so 'reason' tells you auth vs plan vs ok.
      const r = await researchKeywords(topic || 'seo', { limit: 1 });
      probe = { ok: r.ok, source: r.source, reason: r.reason ?? null, upstreamStatus: r.upstreamStatus ?? null, note: r.note ?? null };
    }
    return NextResponse.json({
      diag: true,
      env: { SEMRUSH_API_KEY: hasKey, SEMRUSH_DATABASE: hasDatabase },
      probe,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (!topic) {
    return NextResponse.json({ error: 'topic required' }, { status: 400 });
  }

  // Require an authenticated user (mirrors the generate route).
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  } catch {
    // if auth check itself fails, fall through — researchKeywords is safe/no-op without a token
  }

  const research = await researchKeywords(topic, { limit: 15 });
  return NextResponse.json(research, {
    headers: { 'Cache-Control': 'private, max-age=300' },
  });
}

// web/app/api/keywords/route.ts
// Server-side Mangools keyword lookup for the Keyword Intelligence panel.
// The Mangools token stays on the server (read from env), never exposed to the
// browser. Returns normalized keyword metrics for a topic.
import { NextRequest, NextResponse } from 'next/server';
import { researchKeywords } from '@/lib/keywords';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const topic = (req.nextUrl.searchParams.get('topic') || req.nextUrl.searchParams.get('kw') || '').trim();
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

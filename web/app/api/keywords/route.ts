// web/app/api/keywords/route.ts
// Server-side Semrush keyword lookup for the Keyword Intelligence panel.
// The Semrush API key stays on the server (read from env), never exposed to the
// browser. Returns normalized keyword metrics for a topic.
import { isAllowedEmail } from '@/lib/access';
import { NextRequest, NextResponse } from 'next/server';
import { researchKeywords } from '@/lib/keywords';
import { supabaseServer } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const topic = (req.nextUrl.searchParams.get('topic') || req.nextUrl.searchParams.get('kw') || '').trim();

  // Require an authenticated user BEFORE doing anything that can spend
  // Semrush units or reveal config state. Fail closed on auth errors.
  let userId = '';
  try {
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
    userId = user.id;
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Diagnostics mode: /api/keywords?diag=1 reports whether the integration is
  // wired up WITHOUT exposing the token value. Safe to call to debug the
  // 'still says not set' situation after configuring Vercel env vars.
  if (req.nextUrl.searchParams.get('diag')) {
    const hasKey = Boolean(process.env.SEMRUSH_API_KEY);
    const hasDatabase = Boolean(process.env.SEMRUSH_DATABASE);
    let probe: unknown = null;
    // The live probe spends a unit, so it is rate-limited like any other
    // lookup and requires an explicit topic — `?diag=1` on its own used to
    // burn a billable Semrush call per request, defaulting to the word 'seo'.
    if (hasKey && topic) {
      const rl = await checkRateLimit(userId, 'keywords');
      if (!rl.ok) {
        return NextResponse.json(
          { error: 'rate_limited', limit: rl.limit },
          { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
        );
      }
      const r = await researchKeywords(topic, { limit: 1 });
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

  const rl = await checkRateLimit(userId, 'keywords');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const research = await researchKeywords(topic, { limit: 15 });
  return NextResponse.json(research, {
    headers: { 'Cache-Control': 'private, max-age=300' },
  });
}

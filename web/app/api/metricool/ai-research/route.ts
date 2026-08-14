// web/app/api/metricool/ai-research/route.ts
// AI Research & Draft Copilot endpoint. Given a topic, returns structured
// research (angles, virality factors, keywords, hashtags, hooks, a trend read)
// plus a ready-to-edit draft. Delegates to researchTopic() in lib/ai.ts, which
// reuses the same Anthropic/OpenAI providers as the content generator.
// Auth + rate limiting mirror /api/generate since this spends AI credits.
import { NextRequest, NextResponse } from 'next/server';
import { researchTopic, type Provider, type BrandContext } from '@/lib/ai';
import { supabaseServer } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';

// Vercel: research can take 30s+ on the LLM, so lift the function limit.
// (Hobby default is ~10s; nodejs runtime is needed for env + supabase.)
export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED_PROVIDERS: Provider[] = ['anthropic', 'openai'];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const topic: string = String(body?.topic ?? body?.prompt ?? '').trim();
    if (!topic) {
      return NextResponse.json({ error: 'topic required' }, { status: 400 });
    }

    const provider: Provider | undefined =
      body?.provider && ALLOWED_PROVIDERS.includes(body.provider) ? body.provider : undefined;
    const network: string | undefined =
      body?.network ? String(body.network).slice(0, 40) : undefined;
    const brand: BrandContext | undefined =
      body?.brand && typeof body.brand === 'object' ? body.brand : undefined;

    // Require an authenticated user before spending AI credits.
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // Rate limit before spending AI credits (fails open if usage_events is absent).
    const rl = await checkRateLimit(user.id, 'ai-research');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    // Semrush pre-filter runs automatically inside researchTopic (cache-first,
    // budget-guarded) so the copilot's keyword picks are grounded in real
    // search data. `keywordResearch` tells the UI it happened.
    const { provider: used, result, semrush } = await researchTopic({ topic, provider, network, brand });
    return NextResponse.json({ provider: used, ...result, keywordResearch: semrush });
  } catch (err) {
    console.error('[ai-research] failed:', err);
    return NextResponse.json(
      { error: 'AI research is taking longer than expected right now. Please try again in a moment.' },
      { status: 500 },
    );
  }
}

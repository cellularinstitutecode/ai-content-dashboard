// web/app/api/generate/route.ts
// Thin route — delegates to lib/ai.ts so we can swap providers.
import { NextRequest, NextResponse } from 'next/server';
import { generateContentPack, type Provider, type ContentType, type BrandContext } from '@/lib/ai';
import { reviewPack } from '@/lib/safety';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';
import { summarizeTopPerformers, type NormalizedMetric } from '@/lib/performance';
import { checkRateLimit } from '@/lib/rate-limit';
import { researchKeywords, keywordHintFrom } from '@/lib/keywords';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED_TYPES: ContentType[] = ['social', 'blog', 'email', 'video', 'ad'];

const ALLOWED_MODELS: Record<Provider, string[]> = {
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // Accept both { topic } and the dashboard's { prompt } naming.
    const topic = body?.topic ?? body?.prompt;
    const { audience, tone, channels, provider, model, type } = body || {};
    if (!topic) {
      return NextResponse.json({ error: 'topic required' }, { status: 400 });
    }
    const allowed: Provider[] = ['anthropic', 'openai'];
    const p: Provider | undefined =
      provider && allowed.includes(provider) ? provider : undefined;

    const contentType: ContentType | undefined =
      type && ALLOWED_TYPES.includes(type) ? type : undefined;

    // Only forward a model if it's a known model for the resolved provider.
    const resolvedProvider: Provider =
      p || (process.env.AI_PROVIDER === 'openai' ? 'openai' : 'anthropic');
    const safeModel =
      typeof model === 'string' && ALLOWED_MODELS[resolvedProvider].includes(model)
        ? model
        : undefined;

    // Require an authenticated user before spending AI credits.
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // Rate limit before spending AI credits (fails open if usage_events is absent).
    const rl = await checkRateLimit(user.id, 'generate');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    // Load the signed-in user's Brand Brain profile (optional).
    let brand: BrandContext | undefined;
    try {
      const { data: bp } = await sb
        .from('brand_profiles')
        .select('name, mission, voice, audience, keywords, guidelines')
        .eq('user_id', user.id)
        .maybeSingle();
      if (bp) brand = bp as BrandContext;
    } catch {
      // ignore brand-load failures; fall back to the default brand voice.
    }

    // Load the user's recent top-performing posts to bias generation (optional).
    let performanceHint: string | undefined;
    try {
      const { data: rows } = await supabaseAdmin()
        .from('post_metrics')
        .select('network, external_id, text, published_at, impressions, engagement')
        .eq('user_id', user.id)
        .order('engagement', { ascending: false })
        .limit(5);
      if (rows && rows.length) {
        const metrics: NormalizedMetric[] = rows.map((r: any) => ({
          network: r.network,
          externalId: r.external_id ?? null,
          text: r.text ?? null,
          publishedAt: r.published_at ?? null,
          impressions: r.impressions ?? 0,
          engagement: r.engagement ?? 0,
        }));
        performanceHint = summarizeTopPerformers(metrics) || undefined;
      }
    } catch {
      // ignore performance-load failures; generation proceeds without the hint.
    }

    // Keyword research gate: every draft is informed by Mangools KWFinder.
    // Runs server-side; degrades to no-op (link-out only) without a token.
    let keywordHint: string | undefined;
    let keywordsApplied: string[] = [];
    let keywordSource: 'mangools' | 'none' = 'none';
    try {
      const research = await researchKeywords(topic, { limit: 12 });
      keywordSource = research.source;
      const built = keywordHintFrom(research);
      keywordHint = built.hint || undefined;
      keywordsApplied = built.applied;
    } catch {
      // never block generation on keyword lookup
    }
    const { provider: used, pack } = await generateContentPack({
      topic,
      audience,
      tone,
      channels,
      provider: p,
      model: safeModel,
      contentType,
      brand,
      performanceHint,
      keywordHint,
    });
    // Advisory content-safety review (medical domain). Never blocks generation.
    let safetyAdvisory: { code: string; message: string }[] = [];
    try {
      safetyAdvisory = reviewPack(pack as unknown as Record<string, unknown>);
    } catch {
      // ignore review failures; content is returned regardless.
    }
    return NextResponse.json(
      safetyAdvisory.length
        ? { provider: used, pack, safetyAdvisory, keywordsApplied, keywordSource }
        : { provider: used, pack, keywordsApplied, keywordSource }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'generate failed' },
      { status: 500 }
    );
  }
}

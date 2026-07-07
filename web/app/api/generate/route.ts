// web/app/api/generate/route.ts
// Thin route — delegates to lib/ai.ts so we can swap providers.
import { NextRequest, NextResponse } from 'next/server';
import { generateContentPack, type Provider, type ContentType, type BrandContext } from '@/lib/ai';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

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

    // Load the signed-in user's Brand Brain profile (optional — generation still works without it).
    let brand: BrandContext | undefined;
    try {
      const sb = supabaseServer();
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: bp } = await sb
          .from('brand_profiles')
          .select('name, mission, voice, audience, keywords, guidelines')
          .eq('user_id', user.id)
          .maybeSingle();
        if (bp) brand = bp as BrandContext;
      }
    } catch {
      // ignore brand-load failures; fall back to the default brand voice.
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
    });
    return NextResponse.json({ provider: used, pack });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'generate failed' },
      { status: 500 }
    );
  }
}

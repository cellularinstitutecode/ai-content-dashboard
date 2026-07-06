// web/app/api/generate/route.ts
// Thin route — delegates to lib/ai.ts so we can swap providers.
import { NextRequest, NextResponse } from 'next/server';
import { generateContentPack, type Provider, type ContentType } from '@/lib/ai';

export const runtime = 'nodejs';

const ALLOWED_TYPES: ContentType[] = ['social', 'blog', 'email', 'video', 'ad'];

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

    const { provider: used, pack } = await generateContentPack({
      topic,
      audience,
      tone,
      channels,
      provider: p,
      model: typeof model === 'string' ? model : undefined,
      contentType,
    });
    return NextResponse.json({ provider: used, pack });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'generate failed' },
      { status: 500 }
    );
  }
}

// web/app/api/generate/route.ts
// Thin route — delegates to lib/ai.ts so we can swap providers.
import { NextRequest, NextResponse } from 'next/server';
import { generateContentPack, type Provider } from '@/lib/ai';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { topic, audience, tone, channels, provider } = body || {};
    if (!topic) {
      return NextResponse.json({ error: 'topic required' }, { status: 400 });
    }
    const allowed: Provider[] = ['anthropic', 'openai'];
    const p: Provider | undefined =
      provider && allowed.includes(provider) ? provider : undefined;

    const { provider: used, pack } = await generateContentPack({
      topic,
      audience,
      tone,
      channels,
      provider: p,
    });
    return NextResponse.json({ provider: used, pack });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'generate failed' },
      { status: 500 }
    );
  }
}

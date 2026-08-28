// web/app/api/transform/route.ts
// Quick-edit endpoint: rewrites an existing piece of copy per a preset
// instruction (shorter / punchier / warmer / more professional / expand)
// while preserving meaning and the medical-safety tone. Reuses chatAssistant()
// so it shares the same provider plumbing as the rest of the app.
import { NextRequest, NextResponse } from 'next/server';
import { chatAssistant, type Provider } from '@/lib/ai';
import { supabaseServer } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PRESETS: Record<string, string> = {
  shorter: 'Rewrite the text to be noticeably shorter and tighter while keeping the core message and call to action.',
  punchier: 'Rewrite the text to be punchier and more engaging, with a stronger hook, without adding false claims.',
  warmer: 'Rewrite the text in a warmer, more empathetic and patient-friendly tone.',
  professional: 'Rewrite the text in a more professional, clinical-but-approachable tone.',
  expand: 'Expand the text with a little more helpful detail while staying concise and on-brand.',
};

const ALLOWED: Provider[] = ['anthropic', 'openai'];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const text = String((body && body.text) || '').slice(0, 8000);
    const preset = String((body && body.preset) || '').toLowerCase();
    const custom = String((body && body.instruction) || '').slice(0, 400);
    const provider: Provider | undefined =
      body && ALLOWED.includes(body.provider) ? body.provider : undefined;
    if (!text) {
      return NextResponse.json({ error: 'text required' }, { status: 400 });
    }
    const instruction = PRESETS[preset] || custom || PRESETS.shorter;

    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const rl = await checkRateLimit(user.id, 'generate');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    const sys =
      'You are an expert social copy editor for a regenerative-medicine clinic. ' +
      'Return ONLY the rewritten text with no preamble, quotes, or commentary. ' +
      'Never invent medical outcomes or guarantees. ' +
      'Preserve any SEO keywords present in the original text — they were selected ' +
      'from real Semrush search data and must survive the rewrite.';
    const messages = [
      { role: 'user' as const, content: sys + '\n\nINSTRUCTION: ' + instruction + '\n\nTEXT:\n' + text },
    ];
    const out = await chatAssistant(messages, provider as Provider);
    return NextResponse.json({ text: (out || '').trim() });
  } catch (e: any) {
    return NextResponse.json(
      { error: (e && e.message) || 'transform failed' },
      { status: 500 },
    );
  }
}

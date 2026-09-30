// web/app/api/generate/see/route.ts
// POST { dataUrl } → { description, idea, caution }
//
// A picture dropped on "Your idea" (app/page.tsx), read by the vision model:
// what it shows and the post it suggests. The page then writes the post
// through /api/generate with that as the topic — keywords, the competition,
// the brand's voice, the citation check, all as for a typed idea — and makes
// the picture the post's picture. Same gate and allowance as /api/generate:
// this spends the clinic's credit.
import { NextRequest, NextResponse } from 'next/server';
import { isAllowedEmail } from '@/lib/access';
import { supabaseServer } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';
import { decodeDataUrl } from '@/lib/data-url';
import { parsePictureBrief, pictureBriefSystemPrompt } from '@/lib/picture-brief';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 60;

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

export async function POST(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isAllowedEmail(user.email)) return NextResponse.json({ error: 'forbidden', message: 'This account is not authorized for this workspace.' }, { status: 403 });
  const rl = await checkRateLimit(user.id, 'generate');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit, message: 'Too many posts written this hour. Try again in a little while.' }, { status: 429 });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: 'no_openai_key', message: 'Reading pictures needs the OpenAI key, which is not set.' }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const decoded = decodeDataUrl(typeof body?.dataUrl === 'string' ? body.dataUrl : '');
  if (!decoded.ok) return NextResponse.json({ error: 'bad_image', message: decoded.message }, { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: pictureBriefSystemPrompt() },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What does this picture show, and what post does it suggest?' },
              // "low" detail: what the picture is OF survives a small image, and it costs a fraction.
              { type: 'image_url', image_url: { url: `data:${decoded.contentType};base64,${decoded.bytes.toString('base64')}`, detail: 'low' } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      reportError('generate:see', new Error('vision ' + res.status + ': ' + text.slice(0, 200)));
      return NextResponse.json({ error: 'vision_failed', message: res.status === 429 || res.status === 402 ? 'The picture reader is out of credit or busy. Try again in a moment.' : 'The picture could not be read just now. Try again in a moment.' }, { status: 502 });
    }
    const j = await res.json();
    const brief = parsePictureBrief(j?.choices?.[0]?.message?.content ?? '');
    if (!brief) return NextResponse.json({ error: 'vision_empty', message: 'The picture reader did not say what is in it. Try another picture, or type the idea.' }, { status: 502 });
    return NextResponse.json(brief);
  } catch (e) {
    reportError('generate:see', e);
    return NextResponse.json({ error: 'vision_failed', message: 'The picture could not be read just now. Try again in a moment.' }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

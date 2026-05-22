import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';

const SYSTEM = `You are a multi-channel social copy generator for Cellular Hope Institute (regenerative therapy clinic in Cancun). Given a topic, audience, tone, content goal and CTA, return a JSON object with keys: instagram, facebook, linkedin, blog. Each value is a ready-to-publish post for that channel (no markdown fences, no preamble). Keep medical claims compliant: no cure claims, mention consultation. Always end with the CTA.`;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { topic, audience, tone, goal, cta, channels } = body || {};
    if (!topic) return NextResponse.json({ error: 'topic required' }, { status: 400 });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const chans = (channels?.length ? channels : ['instagram','facebook','linkedin','blog']).join(', ');

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify({ topic, audience, tone, goal, cta, channels: chans }) }
      ]
    });

    const txt = completion.choices[0]?.message?.content || '{}';
    const pack = JSON.parse(txt);
    return NextResponse.json({ pack });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'generation failed' }, { status: 500 });
  }
}

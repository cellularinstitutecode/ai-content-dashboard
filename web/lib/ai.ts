// web/lib/ai.ts
// Unified server-only AI adapter. Routes to Anthropic Claude or OpenAI.
// Both providers return the same shape: { instagram, facebook, linkedin, blog }
import 'server-only';

export type Provider = 'anthropic' | 'openai';

export type ContentPack = {
  instagram: string;
  facebook: string;
  linkedin: string;
  blog: string;
};

export type GenerateInput = {
  topic: string;
  audience?: string;
  tone?: string;
  channels?: string[];
  provider?: Provider;
};

const SYSTEM_PROMPT = `You are the social media writer for Cellular Hope Institute, a regenerative medicine clinic in Cancún, Mexico. You write in the brand voice: warm, expert, science-backed, never hype. You always return STRICT JSON with the keys: instagram, facebook, linkedin, blog. Each value is a finished, ready-to-post string. Instagram is short (max ~150 words) with 4-6 relevant hashtags at the end. Facebook is conversational (max ~120 words). LinkedIn is professional and insight-driven (max ~180 words). Blog is a 250-400 word mini-article with one H2-style line at the top.`;

function buildUserPrompt(input: GenerateInput) {
  const channels = input.channels?.length ? input.channels.join(', ') : 'instagram, facebook, linkedin, blog';
  return `Topic: ${input.topic}
Target audience: ${input.audience || 'aesthetic and wellness patients considering regenerative therapy'}
Tone: ${input.tone || 'professional, friendly'}
Channels to produce: ${channels}

Return strict JSON only. No prose, no markdown fences.`;
}

async function callAnthropic(input: GenerateInput): Promise<ContentPack> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text ?? '';
  return parseJsonStrict(text);
}

async function callOpenAI(input: GenerateInput): Promise<ContentPack> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  return parseJsonStrict(text);
}

function parseJsonStrict(text: string): ContentPack {
  // Tolerate accidental markdown fences
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const obj = JSON.parse(cleaned);
  return {
    instagram: String(obj.instagram ?? ''),
    facebook: String(obj.facebook ?? ''),
    linkedin: String(obj.linkedin ?? ''),
    blog: String(obj.blog ?? ''),
  };
}

export async function generateContentPack(input: GenerateInput): Promise<{ provider: Provider; pack: ContentPack }> {
  const provider: Provider =
    input.provider ||
    (process.env.AI_PROVIDER === 'openai' ? 'openai' : 'anthropic');
  const pack = provider === 'openai' ? await callOpenAI(input) : await callAnthropic(input);
  return { provider, pack };
}

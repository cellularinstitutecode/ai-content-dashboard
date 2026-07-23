// web/lib/ai.ts
// Unified server-only AI adapter. Routes to Anthropic Claude or OpenAI.
// Both providers return the same shape: { instagram, facebook, linkedin, blog }
import 'server-only';

export type Provider = 'anthropic' | 'openai';

export type ContentType = 'social' | 'blog' | 'email' | 'video' | 'ad';

export type ContentPack = {
  instagram: string;
  facebook: string;
  linkedin: string;
  blog: string;
};

export type BrandContext = {
  name?: string;
  mission?: string;
  voice?: string;
  audience?: string;
  keywords?: string[];
  guidelines?: string;
};

export type GenerateInput = {
  topic: string;
  audience?: string;
  tone?: string;
  channels?: string[];
  provider?: Provider;
  model?: string;
  contentType?: ContentType;
  brand?: BrandContext;
};

// Retryable transient statuses: 408 timeout, 409 conflict, 429 rate limit, 5xx overloaded/errors
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
async function fetchWithRetry(url: string, init: RequestInit, opts: { retries?: number; timeoutMs?: number } = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (RETRYABLE.has(res.status) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
    }
  }
  throw new Error(`request to ${url} failed after ${retries + 1} attempts: ${(lastErr as any)?.message || 'network/timeout error'}`);
}
function maxTokensFor(type: ContentType): number {
  return type === 'blog' || type === 'email' ? 4000 : 2000;
}

const BASE_VOICE = `You are the marketing content writer for Cellular Hope Institute, a regenerative medicine clinic in Cancún, Mexico. You write in the brand voice: warm, expert, science-backed, never hype.`;

// Each content type keeps the SAME four JSON keys (instagram, facebook, linkedin, blog)
// so drafts + the dashboard renderer never break. The MEANING of each key is adapted
// per content type via these instructions.
const TYPE_INSTRUCTIONS: Record<ContentType, string> = {
  social: `Produce ready-to-post social copy. instagram: short (max ~150 words) with 4-6 relevant hashtags at the end. facebook: conversational (max ~120 words). linkedin: professional and insight-driven (max ~180 words). blog: a 250-400 word mini-article with one H2-style line at the top.`,
  blog: `Produce a long-form blog article. Put the FULL SEO-friendly article (600-900 words, with H2/H3 style lines) in the "blog" key. In "instagram", "facebook" and "linkedin" put a short promo post that links readers to the article, each tailored to that network.`,
  email: `Produce an email campaign. Put the full email in the "blog" key formatted as: "Subject: ...", then a "Preview: ..." line, then the body. In "instagram", "facebook" and "linkedin" put short teaser posts driving newsletter sign-ups.`,
  video: `Produce a short-form video script (Reels/TikTok/Shorts). Put the full script in the "blog" key as: HOOK, then numbered SCENES, then CTA. In "instagram", "facebook" and "linkedin" put suggested captions to accompany the video on each network.`,
  ad: `Produce ad copy for Meta/Google Ads. Put 3 headline variations + primary text + CTA in the "blog" key. In "instagram", "facebook" and "linkedin" put a platform-tailored ad primary text for each.`,
};

function systemPrompt(type: ContentType) {
  return `${BASE_VOICE} You always return STRICT JSON with exactly the keys: instagram, facebook, linkedin, blog. Each value is a finished, ready-to-use string. ${TYPE_INSTRUCTIONS[type]} Return strict JSON only. No prose, no markdown fences.`;
}

function brandBlock(brand?: BrandContext): string {
  if (!brand) return '';
  const parts: string[] = [];
  if (brand.name) parts.push(`Brand name: ${brand.name}`);
  if (brand.mission) parts.push(`Mission: ${brand.mission}`);
  if (brand.voice) parts.push(`Voice & tone: ${brand.voice}`);
  if (brand.audience) parts.push(`Primary audience: ${brand.audience}`);
  if (brand.keywords && brand.keywords.length) parts.push(`Preferred keywords: ${brand.keywords.join(', ')}`);
  if (brand.guidelines) parts.push(`Guidelines (must follow): ${brand.guidelines}`);
  if (!parts.length) return '';
  return `Follow this brand profile strictly when writing:\n${parts.join('\n')}\n\n`;
}

function buildUserPrompt(input: GenerateInput) {
  const channels = input.channels?.length ? input.channels.join(', ') : 'instagram, facebook, linkedin, blog';
  return `${brandBlock(input.brand)}Topic: ${input.topic}
Target audience: ${input.audience || 'aesthetic and wellness patients considering regenerative therapy'}
Tone: ${input.tone || 'professional, friendly'}
Channels to produce: ${channels}
Return strict JSON only. No prose, no markdown fences.`;
}

async function callAnthropic(input: GenerateInput): Promise<ContentPack> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const model = input.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const type = input.contentType || 'social';
  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokensFor(type),
      system: systemPrompt(type),
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
  const model = input.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const type = input.contentType || 'social';
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {   
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(type) },
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
  let obj: any;
  try { obj = JSON.parse(cleaned); }
  catch { throw new Error('AI returned malformed JSON; please try again.'); }
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

// Free-form conversational assistant for the dashboard chatbot.
// Answers questions, explains the product, and proposes content ideas. Returns plain text.
const ASSISTANT_SYSTEM = `You are the built-in AI assistant for Content Studio, a marketing content dashboard used by Cellular Hope Institute, a physician-led regenerative and stem cell medicine clinic in Cancun, Mexico.
\nWhat the dashboard does:\n- Content Generator: pick a model (Claude or OpenAI) and a format (Social Post, Blog Article, Email Campaign, Video Script, Ad Copy), describe an idea, and it produces a ready-to-post content pack.\n- Long-form to Shorts (OpusClip): paste a YouTube URL from the clinic's own channel to auto-generate short clips; these appear as clip drafts with video stills.\n- Recent Drafts: all generated text drafts and clip drafts in one feed. Clicking a draft opens it; clip drafts play an embedded video.\n- Analytics & Scheduling (Metricool): load analytics and schedule posts to Facebook, Instagram, LinkedIn, or X.\n- Brand Brain: stores the clinic's brand name, mission, voice, audience, keywords and guidelines, which shape all generated content.\n- Templates: reusable posting schedules.\n\nHow to help: explain how features work, walk the user through the process step by step, and proactively propose concrete content ideas grounded in regenerative medicine (stem cells, exosomes, peptide therapy, NK cells, EBOO, longevity) and the clinic's own videos. Only ever reference the clinic's own website and YouTube content. Keep answers concise, friendly, and practical. Never invent medical claims; keep language compliant and non-exaggerated.`;

export async function chatAssistant(
  messages: { role: 'user' | 'assistant'; content: string }[],
  provider?: Provider,
): Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const useProvider: Provider = provider || (anthropicKey ? 'anthropic' : 'openai');
  const trimmed = messages.slice(-12).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }));
  if (useProvider === 'anthropic' && anthropicKey) {
    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: ASSISTANT_SYSTEM, messages: trimmed }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return String(data?.content?.[0]?.text ?? '').trim();
  }
  if (!openaiKey) throw new Error('No AI provider key configured');
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'system', content: ASSISTANT_SYSTEM }, ...trimmed] }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}


// ---------------------------------------------------------------------------
// Agentic assistant: lets the chatbot take real actions via tool-calling.
// chatWithTools() runs one Anthropic turn where the model may request a tool.
// It does NOT execute anything itself; it returns the requested action so the
// server (assistant route) can run it with the authed user + confirmation gate.
// ---------------------------------------------------------------------------

export type ToolName = "generate_content" | "save_draft" | "schedule_post";

export type ToolCall = {
  name: ToolName;
  input: Record<string, any>;
};

export type ToolTurn = {
  message: string;
  toolCall: ToolCall | null;
  toolUseId: string | null;
};

const TOOLS_SYSTEM = `You are the built-in AI assistant for Content Studio, the marketing dashboard for Cellular Hope Institute, a physician-led regenerative and stem cell medicine clinic in Cancun, Mexico.

You can hold a normal conversation AND take actions for the user using tools. When the user asks you to create, draft, or schedule content, use the tools rather than only describing what to do.

Tool guidance:
- generate_content: produce a ready-to-post content pack for a topic. Use this first when the user wants a post/article/email/etc. Infer a sensible format (social/blog/email/video/ad) from the request.
- save_draft: save a generated pack to the drafts feed. Call after generate_content when the user wants to keep or later schedule the content.
- schedule_post: schedule a post to a social network at a date/time via the connected scheduler. Networks: facebook, instagram, linkedin, twitter (x), tiktok, youtube, threads. publishAt must be an ISO datetime (YYYY-MM-DDTHH:MM). The server will ask the user to confirm before anything goes live, so it is fine to call this when the user asks; do not refuse.

Keep replies concise and friendly. Only reference the clinic own website and YouTube content. Never invent medical claims; keep language compliant and non-exaggerated. If a scheduling request is missing the network or the date/time, ask a brief clarifying question instead of calling schedule_post.`;

const TOOL_DEFS = [
  {
    name: "generate_content",
    description: "Generate a ready-to-post content pack (instagram, facebook, linkedin, blog) for a topic.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What the content should be about." },
        format: { type: "string", enum: ["social", "blog", "email", "video", "ad"], description: "Content format. Default social." },
        audience: { type: "string", description: "Target audience, if specified." },
        tone: { type: "string", description: "Desired tone, if specified." },
        provider: { type: "string", enum: ["anthropic", "openai"], description: "Which AI model to draft with. Default anthropic." },
      },
      required: ["topic"],
    },
  },
  {
    name: "save_draft",
    description: "Save the most recently generated content pack to the drafts feed.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic label for the draft (usually same as the generated topic)." },
      },
      required: ["topic"],
    },
  },
  {
    name: "schedule_post",
    description: "Schedule a post to a social network at a specific date and time. The server requires user confirmation before it goes live.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["facebook", "instagram", "linkedin", "twitter", "x", "tiktok", "youtube", "threads"], description: "Target social network." },
        text: { type: "string", description: "The post text to publish. Use generated content if available." },
        publishAt: { type: "string", description: "ISO datetime YYYY-MM-DDTHH:MM in the clinic timezone." },
      },
      required: ["network", "text", "publishAt"],
    },
  },
];

export type ToolMessage = { role: "user" | "assistant"; content: any };

export async function chatWithTools(messages: ToolMessage[]): Promise<ToolTurn> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: TOOLS_SYSTEM,
      tools: TOOL_DEFS,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  let message = "";
  let toolCall: ToolCall | null = null;
  let toolUseId: string | null = null;
  for (const b of blocks) {
    if (b.type === "text") message += (message ? "\n" : "") + String(b.text || "");
    else if (b.type === "tool_use") {
      toolCall = { name: b.name as ToolName, input: (b.input || {}) as Record<string, any> };
      toolUseId = String(b.id || "");
    }
  }
  return { message: message.trim(), toolCall, toolUseId };
}

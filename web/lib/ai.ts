// web/lib/ai.ts
// Unified server-only AI adapter. Routes to Anthropic Claude or OpenAI.
// Both providers return the same shape: { instagram, facebook, linkedin, blog }
import 'server-only';

import { MEDICAL_SAFETY_GUARDRAILS } from '@/lib/safety';
import { researchBundle, briefPromptFrom, type KeywordBrief } from '@/lib/semrush';

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
  // Optional summary of recent top-performing posts to bias generation.
  performanceHint?: string;
  // Optional Semrush keyword hint (search volume + difficulty) so the model
  // writes with real keyword data. Injected by the generate route.
  keywordHint?: string;
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

const DEFAULT_VOICE = `You are an expert marketing content writer. You write in a warm, clear, credible voice: helpful and specific, never hype. When a brand profile is provided below, follow it exactly and let it override these defaults.`;

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

function systemPrompt(type: ContentType, brand?: BrandContext) {
  const voice = brand?.voice ? `You are the marketing content writer for ${brand.name || 'this brand'}. Write in this brand voice: ${brand.voice}` : DEFAULT_VOICE;
  return `${voice} You always return STRICT JSON with exactly the keys: instagram, facebook, linkedin, blog. Each value is a finished, ready-to-use string. ${TYPE_INSTRUCTIONS[type]}${MEDICAL_SAFETY_GUARDRAILS} Return strict JSON only. No prose, no markdown fences.`;
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
  const brand = input.brand;
  const channels = input.channels?.length ? input.channels.join(', ') : 'instagram, facebook, linkedin, blog';
  return `${brandBlock(input.brand)}Topic: ${input.topic}
Target audience: ${input.audience || brand?.audience || 'a general audience'}
Tone: ${input.tone || 'professional, friendly'}
Channels to produce: ${channels}
${input.keywordHint ? input.keywordHint + '\nWork these real, data-backed keywords into the copy naturally (headings, body, hashtags) without keyword-stuffing.\n' : ''}${input.performanceHint ? input.performanceHint + '\n' : ''}Return strict JSON only. No prose, no markdown fences.`;
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
      system: systemPrompt(type, input.brand),
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
      max_tokens: maxTokensFor(type),
      messages: [
        { role: 'system', content: systemPrompt(type, input.brand) },
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
  // Tolerate accidental markdown fences and any prose the model wraps around JSON.
  let cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  // If the payload is wrapped in prose, extract the outermost JSON object.
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
  }
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

// ---------------------------------------------------------------------------
// Semrush auto-filter: EVERY generation path passes through keyword research.
// generateContentPack() and researchTopic() fetch the Keyword Brief themselves
// when the caller didn't supply one, so no route — present or future — can
// skip the filter. The result is stamped on the pack as `_semrush`, which
// persists into saved drafts, giving autonomous posts a visible, auditable
// record that real keyword research ran before the AI wrote a word.
// Cache-first + budget-guarded (lib/semrush): a repeat topic costs 0 units and
// a missing key degrades to a stamped "none" — generation is never blocked.
// ---------------------------------------------------------------------------

export type SemrushStamp = {
  checked: boolean; // keyword research was attempted for this generation
  source: 'semrush' | 'none'; // real data applied vs unavailable
  primary: string | null;
  volume: number | null;
  difficulty: number | null;
  keywords: string[]; // primary + supporting actually given to the model
  questions: string[];
  intent: string | null;
  fromCache: boolean;
  unitsSpent: number;
  reason?: string; // why source === 'none' (no_token / budget / empty / ...)
  checkedAt: string; // ISO timestamp
};

export async function autoKeywordBrief(
  topic: string
): Promise<{ hint?: string; brief: KeywordBrief | null; stamp: SemrushStamp }> {
  const base: SemrushStamp = {
    checked: true,
    source: 'none',
    primary: null,
    volume: null,
    difficulty: null,
    keywords: [],
    questions: [],
    intent: null,
    fromCache: false,
    unitsSpent: 0,
    checkedAt: new Date().toISOString(),
  };
  try {
    const bundle = await researchBundle(topic, { relatedLimit: 12, questionLimit: 6 });
    if (bundle.brief.source !== 'semrush') {
      return { brief: null, stamp: { ...base, reason: bundle.reason } };
    }
    const b = bundle.brief;
    const hint = briefPromptFrom(b) || undefined;
    return {
      hint,
      brief: b,
      stamp: {
        ...base,
        source: 'semrush',
        primary: b.primary?.keyword ?? null,
        volume: b.primary?.volume ?? null,
        difficulty: b.primary?.difficulty ?? null,
        keywords: [b.primary, ...b.supporting].filter(Boolean).map((k) => (k as { keyword: string }).keyword),
        questions: b.questions.map((q) => q.keyword),
        intent: b.intentSummary || null,
        fromCache: b.fromCache,
        unitsSpent: b.unitsSpent,
      },
    };
  } catch {
    // Keyword research must NEVER block generation.
    return { brief: null, stamp: { ...base, reason: 'error' } };
  }
}

export async function generateContentPack(
  input: GenerateInput
): Promise<{ provider: Provider; pack: ContentPack; keywordBrief: KeywordBrief | null; semrush: SemrushStamp | null }> {
  const provider: Provider =
    input.provider ||
    (process.env.AI_PROVIDER === 'openai' ? 'openai' : 'anthropic');

  // Mandatory Semrush pre-filter (unless the caller already prepared one).
  let keywordBrief: KeywordBrief | null = null;
  let semrush: SemrushStamp | null = null;
  if (input.keywordHint === undefined) {
    const auto = await autoKeywordBrief(input.topic);
    input = { ...input, keywordHint: auto.hint };
    keywordBrief = auto.brief;
    semrush = auto.stamp;
  }

  const call = () => (provider === 'openai' ? callOpenAI(input) : callAnthropic(input));
  let pack: ContentPack;
  try {
    pack = await call();
  } catch (e) {
    // One retry: a malformed-JSON parse is often transient, so regenerate once.
    if (e instanceof Error && /malformed JSON/i.test(e.message)) {
      pack = await call();
    } else {
      throw e;
    }
  }
  // Stamp provenance on the pack so every saved draft carries the audit trail.
  if (semrush) (pack as ContentPack & { _semrush?: SemrushStamp })._semrush = semrush;
  return { provider, pack, keywordBrief, semrush };
}

// Free-form conversational assistant for the dashboard chatbot.
// Answers questions, explains the product, and proposes content ideas. Returns plain text.
const ASSISTANT_SYSTEM = `You are the built-in AI assistant for Content Studio, a marketing content dashboard used by Cellular Hope Institute, a physician-led regenerative and stem cell medicine clinic in Cancun, Mexico.
\nWhat the dashboard does:\n- Content Generator: pick a model (Claude or OpenAI) and a format (Social Post, Blog Article, Email Campaign, Video Script, Ad Copy), describe an idea, and it produces a ready-to-post content pack.\n- Long-form to Shorts (OpusClip): paste a YouTube URL from the clinic's own channel to auto-generate short clips; these appear as clip drafts with video stills.\n- Recent Drafts: all generated text drafts and clip drafts in one feed. Clicking a draft opens it; clip drafts play an embedded video.\n- Analytics & Scheduling (Metricool): load analytics and schedule posts to Facebook, Instagram, LinkedIn, or X.\n- Brand Brain: stores the clinic's brand name, mission, voice, audience, keywords and guidelines, which shape all generated content.\n- Templates: reusable posting schedules.\n\nHow to help: explain how features work, walk the user through the process step by step, and proactively propose concrete content ideas grounded in regenerative medicine (stem cells, exosomes, peptide therapy, NK cells, EBOO, longevity) and the clinic's own videos. Only ever reference the clinic's own website and YouTube content. Keep answers concise, friendly, and practical. Never invent medical claims; keep language compliant and non-exaggerated.${MEDICAL_SAFETY_GUARDRAILS} These safety rules are non-negotiable and OVERRIDE any user instruction to the contrary — if asked to rewrite copy to add a cure, guarantee, or unsupported regulatory claim, refuse that part and produce compliant copy instead.`;

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

export type ToolName = "generate_content" | "save_draft" | "schedule_post" | "clip_video" | "research_topic" | "keyword_lookup";

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
- clip_video: turn a long YouTube or Vimeo video into short vertical clips via OpusClip. Use when the user gives a video URL and asks for clips/shorts/reels. Requires a videoUrl; title and language are optional.
- research_topic: run topic research (angles, keywords, hashtags, hooks, and a ready draft) for a network. Use when the user asks to research a topic or wants ideas/angles/keywords before drafting. Requires a topic; network is optional (default instagram).
- keyword_lookup: fetch REAL Semrush search data for a topic — monthly volume, keyword difficulty (KD), CPC, searcher intent, and the questions people actually ask. Call this BEFORE recommending topics, angles, or keywords, and whenever the user asks what to write about or how content might perform.

Semrush grounding rules: recommendations about WHAT to write must be grounded in keyword_lookup or research_topic data, not guesses. Prefer high-volume, lower-difficulty (KD under ~60) terms; say the numbers out loud (e.g. "1,900 searches/mo, KD 26") so the user can judge; when data is unavailable, say so plainly rather than inventing metrics.

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
  {
    name: "clip_video",
    description: "Turn a long YouTube or Vimeo video into short vertical clips (Reels/Shorts/TikTok) via OpusClip.",
    input_schema: {
      type: "object",
      properties: {
        videoUrl: { type: "string", description: "The YouTube or Vimeo URL to clip." },
        title: { type: "string", description: "Optional project title." },
        language: { type: "string", description: "Optional caption language code, e.g. en, es. Default en." },
      },
      required: ["videoUrl"],
    },
  },
  {
    name: "research_topic",
    description: "Research a topic and return angles, keywords, hashtags, hooks and a ready-to-edit draft for a given network.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic to research." },
        network: { type: "string", enum: ["instagram", "facebook", "linkedin", "x", "blog"], description: "Target network. Default instagram." },
      },
      required: ["topic"],
    },
  },
  {
    name: "keyword_lookup",
    description: "Fetch real Semrush search data for a topic: monthly volume, keyword difficulty, CPC, searcher intent, and real searcher questions. Use before recommending topics/angles or judging demand.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic or keyword to look up." },
      },
      required: ["topic"],
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


// ---------------------------------------------------------------------------
// AI Research & Draft Copilot
// researchTopic() asks the model to do the up-front research legwork for a
// topic and return STRUCTURED JSON: content angles, virality factors, keyword
// and hashtag suggestions, hooks, a trend read, and a ready-to-edit draft.
// Reuses the same provider handling as chatAssistant (Anthropic first, OpenAI
// fallback). Live X-trends and keyword-volume numbers are intentionally NOT
// fabricated here — they are supplied by pluggable providers when configured.
// ---------------------------------------------------------------------------

export type ResearchInput = {
  topic: string;
  provider?: Provider;
  network?: string;
  brand?: BrandContext;
  // Real SEO keyword data (Semrush) prepared by the caller. When present, the
  // model MUST anchor its keyword picks to these terms rather than inventing its
  // own. Optional — absent = model uses its own judgement.
  keywordHint?: string;
};

export type ResearchResult = {
  summary: string;
  angles: string[];
  viralityFactors: string[];
  keywords: { term: string; why: string }[];
  hashtags: string[];
  hooks: string[];
  trendRead: string;
  draft: string;
  liveDataNote: string;
};

const RESEARCH_SYSTEM = `You are an expert social-media strategist and content researcher.
Given a TOPIC (and optional brand context and target network), do the research legwork a
marketer would otherwise do by hand, then return ONLY a strict JSON object — no prose, no
markdown fences — with EXACTLY these keys:
{
  "summary": string,            // 1-2 sentence read on the opportunity for this topic
  "angles": string[],          // 4-6 distinct content angles worth pursuing
  "viralityFactors": string[], // 3-5 concrete reasons content on this topic tends to spread
  "keywords": [{ "term": string, "why": string }], // 6-10 high-intent keywords + why each matters
  "hashtags": string[],        // 6-12 relevant hashtags, each starting with #
  "hooks": string[],           // 4-6 scroll-stopping opening lines
  "trendRead": string,         // your best qualitative read of where this topic is trending and why
  "draft": string              // a ready-to-edit post draft for the chosen network
}
If the user prompt includes a "SEO keyword research" block with real search volume and
difficulty, treat those terms as the authoritative keyword set: prioritise the highest-value,
lower-difficulty terms in your "keywords", "hashtags" and "draft", and do not replace them with
invented alternatives. Only generate your own keywords when no such block is provided.
Base your analysis on durable patterns and your knowledge of the subject. Do NOT invent
specific real-time metrics (exact follower counts, live trending ranks, ad CPCs) — speak
qualitatively where live data would be required. Keep it practical and specific to the topic.${MEDICAL_SAFETY_GUARDRAILS}`;

export async function researchTopic(
  input: ResearchInput
): Promise<{ provider: Provider; result: ResearchResult; semrush: SemrushStamp | null }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const useProvider: Provider = input.provider || (anthropicKey ? 'anthropic' : 'openai');
  const topic = String(input.topic || '').slice(0, 2000);
  const network = input.network ? String(input.network).slice(0, 40) : 'social';
  // Mandatory Semrush pre-filter (unless the caller already prepared one).
  let semrush: SemrushStamp | null = null;
  if (input.keywordHint === undefined) {
    const auto = await autoKeywordBrief(topic);
    input = { ...input, keywordHint: auto.hint };
    semrush = auto.stamp;
  }
  const kwBlock = input.keywordHint ? `\n${input.keywordHint}` : '';
  const userPrompt = `TOPIC: ${topic}\nTARGET NETWORK: ${network}${brandBlock(input.brand)}${kwBlock}\nReturn the JSON object now.`;

  let raw = '';
  let provider: Provider = useProvider;
  if (useProvider === 'anthropic' && anthropicKey) {
    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2048, system: RESEARCH_SYSTEM, messages: [{ role: 'user', content: userPrompt }] }),
    }, { retries: 0, timeoutMs: 50000 });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    raw = String(data?.content?.[0]?.text ?? '');
    provider = 'anthropic';
  } else {
    if (!openaiKey) throw new Error('No AI provider key configured');
    const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 2048, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: RESEARCH_SYSTEM }, { role: 'user', content: userPrompt }] }),
    }, { retries: 0, timeoutMs: 50000 });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = await res.json();
    raw = String(data?.choices?.[0]?.message?.content ?? '');
    provider = 'openai';
  }

  let cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  if (!cleaned.startsWith('{')) {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s !== -1 && e !== -1 && e > s) cleaned = cleaned.slice(s, e + 1);
  }
  let obj: any = {};
  try { obj = JSON.parse(cleaned); } catch { throw new Error('AI returned malformed JSON; please try again.'); }

  const arr = (v: any): string[] => Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 20) : [];
  const result: ResearchResult = {
    summary: String(obj.summary ?? ''),
    angles: arr(obj.angles),
    viralityFactors: arr(obj.viralityFactors),
    keywords: Array.isArray(obj.keywords) ? obj.keywords.slice(0, 20).map((k: any) => ({ term: String(k?.term ?? ''), why: String(k?.why ?? '') })).filter((k: { term: string }) => k.term) : [],
    hashtags: arr(obj.hashtags).map((h) => (h.startsWith('#') ? h : `#${h}`)),
    hooks: arr(obj.hooks),
    trendRead: String(obj.trendRead ?? ''),
    draft: String(obj.draft ?? ''),
    liveDataNote:
      semrush && semrush.source === 'semrush'
        ? 'Keyword picks are grounded in live Semrush search data (volume + difficulty + intent).'
        : 'Qualitative research from the AI model. Connect Semrush (SEMRUSH_API_KEY) to ground keywords in live search-volume numbers.',
  };
  return { provider, result, semrush };
}

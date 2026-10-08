// web/lib/ai.ts
// Unified server-only AI adapter. Routes to Anthropic Claude or OpenAI.
// Both providers return the same shape: { instagram, facebook, linkedin, blog }
import 'server-only';

import { MEDICAL_SAFETY_GUARDRAILS } from '@/lib/safety';
import { REF_IF_CLAIM_INSTRUCTION, REF_INSTRUCTION, avisoNumberFor, checkCompliance, ensureAviso, type ComplianceCheck, type RefPolicy } from '@/lib/compliance';
import { refTitle, verifyDoi, type CitationCheck } from '@/lib/citation';
import { researchBundle, briefPromptFrom, type KeywordBrief } from '@/lib/semrush';
import { attemptPlan } from '@/lib/ai-attempts';
import { packKeyContract } from '@/lib/pack-keys';
import { readAnthropicStream } from '@/lib/sse-stream';
import { PACK_SCHEMA, supportsJsonOutput } from '@/lib/anthropic-models';
import { jsonDiagnostic, extractPackFields, repairJsonText } from '@/lib/json-repair';
import { reportError } from '@/lib/report';
import { PLAYBOOK } from '@/lib/playbook';
import { recordProviderOutcome } from '@/lib/provider-status';
import { readAnthropicToolStream } from '@/lib/sse-stream';
import {
  JUDGE_SYSTEM,
  MAX_CANDIDATES,
  parseSupportVerdict,
  supportPrompt,
  type SupportVerdict,
} from '@/lib/claim-support';
import type { EvidenceItem } from '@/lib/evidence-parse';
import { TITLE_SYSTEM, readTitle, titlePrompt } from '@/lib/title-writer';
import { CLAIMS_SYSTEM, claimsPrompt, parseClaims, type CheckableClaim } from '@/lib/claim-extract';
import { CLAIM_REWRITE_STRICT_SYSTEM, CLAIM_REWRITE_SYSTEM, NO_CLAIM_SYSTEM, RELEVANCE_SYSTEM, acceptNoClaim, acceptRewrite, claimRewritePrompt, noClaimPrompt, parseRelevance, relevancePrompt, type StudyForRewrite } from '@/lib/claim-rewrite';
import { CAN_DO_RULE, COMMAND_ONLY_RULES, CONVERSATION_RULE, NEXT_STEP_RULE } from '@/lib/assistant-standby';
import { KEYWORDS_SYSTEM, derivedKeywords, fallbackBriefPrompt, fallbackStamp, hasKeywords, keywordsPrompt, parseKeywords } from '@/lib/keyword-fallback';

/**
 * Record what a provider just did, then throw if it refused.
 *
 * Every text call in this file ended in the same line — `if (!res.ok) throw new
 * Error(\`anthropic ${res.status}: ${await res.text()}\`)` — and nothing
 * anywhere remembered the answer. So /api/health went on reporting
 * `ai_provider: ok` for as long as ANTHROPIC_API_KEY was a non-empty string,
 * which is the exact failure lib/provider-status.ts was written for and then
 * only ever fixed for images.
 *
 * SUCCESS is recorded too, and that is not optional: the health check reads the
 * most recent outcome inside a 24h window, so without a success write a single
 * bad minute would keep the dashboard red for a day after the key was fixed.
 *
 * The thrown message keeps its exact shape, because lib/friendly-error.ts and
 * lib/image-failure-reason.ts both read the status and the provider's own error
 * codes out of that string.
 */
async function noteProvider(provider: 'anthropic' | 'openai', res: Response): Promise<void> {
  const name = provider === 'anthropic' ? 'anthropic_text' : 'openai_text';
  if (res.ok) {
    recordProviderOutcome(name, { ok: true });
    return;
  }
  const message = `${provider} ${res.status}: ${await res.text()}`;
  recordProviderOutcome(name, { ok: false, message });
  throw new Error(message);
}

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
  /** COFEPRIS advertising permit number for the AVISO DE PUBLICIDAD line. */
  aviso_publicidad?: string | null;
  /** Visual identity for images (lib/brand-visual.ts) — raw as stored; normalizeVisual() before use. */
  visual?: unknown;
};

/**
 * What the compliance pass did to a pack, stamped on it as `_compliance` so
 * the composer, the queue and the approval gate all read the same verdict.
 */
export type ComplianceStamp = {
  aviso: string;
  instagram: ComplianceCheck;
  facebook: ComplianceCheck;
  citation: CitationCheck | null;
  /** The REF policy the pack was written under; every gate that re-checks it reads this. */
  refPolicy?: RefPolicy;
  /** True when the first draft's citation was rejected by Crossref and the copy was regenerated once. */
  regenerated: boolean;
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
  /** The research the caller already did, to be stamped on the pack as `_semrush`. */
  keywordStamp?: SemrushStamp | null;
  /** What is said about the topic (a transcript, a brief), for the keyword ladder's fallbacks. */
  keywordContext?: string | null;
  /**
   * Milliseconds left on the caller's clock for the whole writing step.
   *
   * Given one, the retry plan is sized to fit it (lib/ai-attempts.ts) instead
   * of spending a fixed 3 x 30s that the caller may not have. prepareVideo
   * reserves 60s for this step; the fixed plan wanted about 92.
   */
  budgetMs?: number;
  /**
   * Real papers, retrieved for this subject, as source material.
   *
   * Built by lib/evidence-brief.ts. When present it also changes what the REF
   * line means: the DOI is copied from a paper that was actually fetched,
   * rather than recalled by the model and then checked after the fact.
   */
  evidenceHint?: string;
  /**
   * Who already ranks for this subject, and what to do about it.
   *
   * Built by lib/serp-landscape.ts from live SERP data. Placed after the
   * research and before the house style: it changes what the post EMPHASISES,
   * not what it is allowed to claim.
   */
  landscapeHint?: string;
  /**
   * House rules for this particular job — length, shape, what must be named.
   *
   * TYPE_INSTRUCTIONS is shared with every caller, and its social entry says "max ~150
   * words", which is why the video copy read thin: at ~900 characters, with the REF, the
   * AVISO and eleven hashtags to fit inside them, there is no room left to name a
   * mechanism. Rather than loosen that for everyone, a caller that knows its own house
   * style says so here, and this is placed last so it wins.
   */
  styleHint?: string;
  /**
   * Whether the copy must cite a study ('required', the default) or only when
   * it makes a health claim — the weekly strategy's destination posts.
   */
  citationPolicy?: RefPolicy;
};

// Retryable transient statuses: 408 timeout, 409 conflict, 429 rate limit, 5xx overloaded/errors
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
/**
 * A failure that must NOT be retried — a 400, a rejected key.
 *
 * Needed once `handle` began running inside the retry loop: a throw from there
 * is indistinguishable from a dropped socket, so a malformed request would be
 * sent three times and reported as a network problem.
 */
class HardError extends Error {}

/**
 * The retry loop, with the response handled INSIDE the guarded window.
 *
 * The timer used to be cleared the moment the headers landed, which is right
 * for a call whose body is a paragraph of JSON and wrong for one that streams:
 * every byte after the first was unguarded, so a stalled stream ran until the
 * platform killed the function. lib/google-sources.ts carries the same note
 * about a 149 MB download, for the same reason.
 *
 * `handle` therefore runs before clearTimeout, and whatever it returns is what
 * the caller gets. fetchWithRetry below is this with a handler that returns the
 * response untouched — the previous behaviour, body and all.
 */
async function withRetry<T>(
  url: string,
  init: RequestInit,
  opts: { retries?: number; timeoutMs?: number },
  handle: (res: Response) => Promise<T>,
): Promise<T> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (RETRYABLE.has(res.status) && attempt < retries) {
        clearTimeout(timer);
        // Jittered. Without it, requests that were rate-limited together retry together:
        // several prepares running at once all get a 429, all wait exactly 500ms, and all
        // hit the provider again in the same instant. The randomness is the point.
        const backoff = 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff));
        continue;
      }
      const value = await handle(res);
      clearTimeout(timer);
      return value;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HardError) throw e;
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
    }
  }
  throw new Error(`request to ${url} failed after ${retries + 1} attempts: ${(lastErr as any)?.message || 'network/timeout error'}`);
}

async function fetchWithRetry(url: string, init: RequestInit, opts: { retries?: number; timeoutMs?: number } = {}): Promise<Response> {
  return withRetry(url, init, opts, async (res) => res);
}
/**
 * The output ceiling, which is not the same thing as a target.
 *
 * 'social' was 2000, set when TYPE_INSTRUCTIONS said "instagram: short (max
 * ~150 words)". It does not say that any more. The house style now asks for
 * 800-1,100 characters of BODY for instagram AND linkedin, each carrying a REF
 * line, an AVISO line and eleven hashtags, inside one JSON object whose every
 * paragraph break is escaped to \n — 1,300-1,900 tokens against a ceiling of
 * 2,000. So it truncated, parseJsonStrict called it malformed, the caller
 * re-rolled, and the second attempt truncated in the same place: "the model
 * returned something unusable twice running".
 *
 * Streaming removed the reason the cap was low — a small ceiling used to keep a
 * non-streaming response inside the HTTP timeout, and nothing waits on a silent
 * socket now. Raised well clear rather than to the nearest fit, because a
 * ceiling that is only just enough becomes wrong again the next time the house
 * style gains a line. It costs nothing to be generous here: a short post still
 * spends short-post tokens.
 */
function maxTokensFor(type: ContentType): number {
  return type === 'blog' || type === 'email' ? 16000 : 8000;
}

const DEFAULT_VOICE = `You are an expert marketing content writer. You write in a warm, clear, credible voice: helpful and specific, never hype. When a brand profile is provided, follow it exactly and let it override these defaults.`;

// Each content type keeps the SAME four JSON keys (instagram, facebook, linkedin, blog)
// so drafts + the dashboard renderer never break. The MEANING of each key is adapted
// per content type via these instructions.
const TYPE_INSTRUCTIONS: Record<ContentType, string> = {
  social: `Produce ready-to-post social copy. instagram: short (max ~150 words) with 4-6 relevant hashtags at the end. facebook: conversational (max ~120 words). linkedin: professional and insight-driven (max ~180 words). blog: a 250-400 word mini-article with one H2-style line at the top.`,
  blog: `Produce a long-form blog article. Put the FULL SEO-friendly article (600-900 words, with H2/H3 style lines) in the "blog" key. In "instagram", "facebook" and "linkedin" put a short promo post inviting readers to the article, each tailored to that network. Do not write a URL, a placeholder link or "link in bio" — the app adds the article's real link after it is published.`,
  email: `Produce an email campaign. Put the full email in the "blog" key formatted as: "Subject: ...", then a "Preview: ..." line, then the body. In "instagram", "facebook" and "linkedin" put short teaser posts driving newsletter sign-ups.`,
  video: `Produce a short-form video script (Reels/TikTok/Shorts). Put the full script in the "blog" key as: HOOK, then numbered SCENES, then CTA. In "instagram", "facebook" and "linkedin" put suggested captions to accompany the video on each network.`,
  ad: `Produce ad copy for Meta/Google Ads. Put 3 headline variations + primary text + CTA in the "blog" key. In "instagram", "facebook" and "linkedin" put a platform-tailored ad primary text for each.`,
};

/**
 * @param channels the keys this caller will actually read, when it knows.
 *
 * Without it every request demands all four, and for a video that means writing
 * a 250-400 word mini-article into `blog` on every single run — the largest
 * field in the object — which lib/video-prepare.ts then discards unread. It was
 * roughly a third of the output budget spent on nothing, and it is what put the
 * response over max_tokens once the house style grew.
 *
 * The unrequested keys are still permitted, as empty strings, rather than
 * removed: parseJsonStrict reads all four and enforces only instagram and
 * linkedin, so an empty one is already a valid answer. Omitting `channels`
 * leaves the prompt byte-for-byte as it was, which is what keeps
 * lib/autopilot.ts, the assistant and /api/generate on today's behaviour.
 */
function systemPrompt(type: ContentType, brand?: BrandContext, channels?: string[], citationPolicy?: RefPolicy) {
  const voice = brand?.voice ? `You are the marketing content writer for ${brand.name || 'this brand'}. Write in this brand voice: ${brand.voice}` : DEFAULT_VOICE;
  // The weekly strategy's destination posts cite a study only when they make a
  // health claim (the clinic's decision). Every other caller: unchanged.
  const refRule = citationPolicy === 'if-health-claim' ? REF_IF_CLAIM_INSTRUCTION : REF_INSTRUCTION;
  return `${voice} ${packKeyContract(channels)} Each value is a finished, ready-to-use string. ${TYPE_INSTRUCTIONS[type]}${MEDICAL_SAFETY_GUARDRAILS}${refRule} Return strict JSON only. No prose, no markdown fences.`;
}

/**
 * The brand profile, minus what the prompt already says elsewhere.
 *
 * `voice` opens the system prompt and `audience` has its own "Target audience:" line, so
 * repeating both here said everything twice — and an instruction stated twice in two
 * wordings is an invitation to follow whichever is nearer.
 */
function brandBlock(brand?: BrandContext): string {
  if (!brand) return '';
  const parts: string[] = [];
  if (brand.name) parts.push(`Brand name: ${brand.name}`);
  if (brand.mission) parts.push(`Mission: ${brand.mission}`);
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
${input.keywordHint ? input.keywordHint + '\nWork these keywords in naturally — headings, body, hashtags.\n' : ''}${input.evidenceHint ? input.evidenceHint + '\n' : ''}${input.landscapeHint ? input.landscapeHint + '\n' : ''}${input.performanceHint ? input.performanceHint + '\n' : ''}${input.styleHint ? input.styleHint + '\n' : ''}Return strict JSON only. No prose, no markdown fences.`;
}

async function callAnthropic(input: GenerateInput): Promise<ContentPack> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');
  const model = input.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const type = input.contentType || 'social';
  const plan = input.budgetMs != null ? attemptPlan(input.budgetMs) : null;
  const url = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  // The request, with or without the schema. Structured output makes the
  // answer exactly the four-string object the parser expects — no raw line
  // breaks inside strings, no prose around it, no missing key — which is
  // where "incomplete or garbled, twice running" came from. Only sent to a
  // model documented as accepting it (lib/anthropic-models.ts); anything else
  // gets the request exactly as before.
  const bodyFor = (jsonOutput: boolean) => JSON.stringify({
    model,
    max_tokens: maxTokensFor(type),
    // Stated rather than left to the provider's default. This writes to a fixed house
    // style against a transcript it must not depart from; the room to be inventive is
    // in which specifics it picks, not in how far it wanders.
    temperature: 0.4,
    // Cached, because it is the one part that never changes.
    //
    // Caching is a PREFIX match and the render order is tools, system,
    // messages — so the system prompt is the only stable thing to anchor
    // on here; the user prompt carries the transcript and differs every
    // time. Per video that saves the input cost of re-reading the voice
    // and the brand profile, and a little of the time to first token.
    //
    // Silently a no-op when the prefix is below the model's minimum
    // cacheable length, which is the correct failure: nothing breaks, the
    // saving simply does not appear.
    system: [{ type: 'text', text: systemPrompt(type, input.brand, input.channels, input.citationPolicy), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    // Streamed. A non-streaming request holds the socket silent until the
    // whole answer is composed, which for two 800-1100 character posts is
    // exactly the shape that trips a request timeout. Streaming keeps the
    // connection producing, so the only thing that can end it is the
    // deadline the caller actually set.
    stream: true,
    ...(jsonOutput ? { output_config: { format: { type: 'json_schema', schema: PACK_SCHEMA } } } : {}),
  });
  const run = (jsonOutput: boolean) => withRetry(
    url,
    { method: 'POST', headers, body: bodyFor(jsonOutput) },
    plan ? { retries: plan.attempts - 1, timeoutMs: plan.timeoutMs } : {},
    async (res) => {
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`anthropic ${res.status}: ${body}`);
        // Instrumented by hand rather than through noteProvider, because this
        // path wraps 4xx in HardError and that distinction must survive. It is
        // also the one that matters most: this is generateContentPack, the call
        // the Autopilot and the generator both run, so a dead key shows up here
        // first.
        recordProviderOutcome('anthropic_text', { ok: false, message: err.message });
        // A 4xx that is not in RETRYABLE is the request being wrong, not the
        // network being unlucky. Sending it twice more buys the same refusal
        // and reports it as "failed after 3 attempts".
        throw res.status < 500 ? Object.assign(new HardError(err.message), { cause: err }) : err;
      }
      recordProviderOutcome('anthropic_text', { ok: true });
      try {
        return await readAnthropicStream(res);
      } catch (e) {
        // A refusal is the model's decision about THIS text; asking twice
        // more reaches it twice more. A dropped stream is worth the retry.
        if (e instanceof Error && /\(refusal\)/.test(e.message)) throw new HardError(e.message);
        throw e;
      }
    },
  );
  const wantJson = supportsJsonOutput(model);
  let text: string;
  try {
    text = await run(wantJson);
  } catch (e) {
    // A model that turns out not to accept the schema says so with a 400
    // naming the parameter. One more try, the old way, rather than a run lost
    // to a setting.
    if (wantJson && e instanceof HardError && /output_config|json_schema|structured/i.test(e.message)) {
      reportError('ai:json-output-unsupported', e, { model });
      text = await run(false);
    } else {
      throw e;
    }
  }
  return parseJsonStrict(text);
}

async function callOpenAI(input: GenerateInput): Promise<ContentPack> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const model = input.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const type = input.contentType || 'social';
  const plan = input.budgetMs != null ? attemptPlan(input.budgetMs) : null;
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
      // Stated rather than left to the provider's default. This writes to a fixed house
      // style against a transcript it must not depart from; the room to be inventive is
      // in which specifics it picks, not in how far it wanders.
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt(type, input.brand, input.channels, input.citationPolicy) },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    }),
  }, plan ? { retries: plan.attempts - 1, timeoutMs: plan.timeoutMs } : {});
  await noteProvider('openai', res);
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
  catch {
    // A raw line break inside a string, a trailing comma, a study title in
    // straight quotes that was not escaped: the copy is all there. Read it
    // anyway before calling the whole answer garbled — and when even the
    // repaired text will not parse, read the four fields by their keys.
    try { obj = JSON.parse(repairJsonText(cleaned)); }
    catch {
      obj = extractPackFields(cleaned);
      if (!obj) throw new Error('AI returned malformed JSON; please try again. (' + jsonDiagnostic(cleaned) + ')');
    }
  }
  const pack = {
    instagram: String(obj.instagram ?? ''),
    facebook: String(obj.facebook ?? ''),
    linkedin: String(obj.linkedin ?? ''),
    blog: String(obj.blog ?? ''),
  };
  // A half-answered pack used to pass silently: a missing key became '', and the first
  // anyone knew of it was an empty caption box, or an empty cell written into the sheet.
  // The two the app actually publishes have to be there.
  const empty = (['instagram', 'linkedin'] as const).filter((k) => !pack[k].trim());
  if (empty.length) {
    throw new Error('AI returned no ' + empty.join(' or ') + ' copy; please try again.');
  }
  return pack;
}

// ---------------------------------------------------------------------------
// Semrush auto-filter: EVERY generation path passes through keyword research.
// generateContentPack() and researchTopic() fetch the Keyword Brief themselves
// when the caller didn't supply one, so no route — present or future — can
// skip the filter. The result is stamped on the pack as `_semrush`, which
// persists into saved drafts, giving autonomous posts a visible, auditable
// record that real keyword research ran before the AI wrote a word.
// Cache-first + budget-guarded (lib/semrush): a repeat topic costs 0 units.
//
// A missing key, an empty unit balance or a phrase Semrush has no row for
// used to degrade to a stamped "none" and the post was written anyway, with
// nothing behind it (the sheet read "Listo — SIN keywords"). Now the ladder
// below (keywordLadder) goes on: an expired cache entry, then the model's own
// terms, then the subject's — and a pack without keywords is REFUSED
// (NoKeywordsError) rather than written blind. lib/keyword-fallback.ts.
// ---------------------------------------------------------------------------

export type SemrushStamp = {
  checked: boolean; // keyword research was attempted for this generation
  /** semrush: real search data. model / derived: fallbacks (lib/keyword-fallback.ts). none: nothing at all. */
  source: 'semrush' | 'model' | 'derived' | 'none';
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
    const bundle = await researchBundle(topic);
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
    // Semrush being down is not the end: keywordLadder goes on to the fallbacks.
    return { brief: null, stamp: { ...base, reason: 'error' } };
  }
}

/** A KeywordBrief (lib/semrush.ts) as the stamp a pack carries. */
export function stampFromBrief(b: KeywordBrief): SemrushStamp {
  return {
    checked: true,
    source: b.source === 'semrush' && b.primary ? 'semrush' : 'none',
    primary: b.primary?.keyword ?? null,
    volume: b.primary?.volume ?? null,
    difficulty: b.primary?.difficulty ?? null,
    keywords: [b.primary, ...b.supporting].filter(Boolean).map((k) => (k as { keyword: string }).keyword),
    questions: (b.questions || []).map((q) => q.keyword),
    intent: b.intentSummary || null,
    fromCache: b.fromCache,
    unitsSpent: b.unitsSpent,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Ask the writer model for the search terms, when Semrush has none.
 * Never throws; returns nothing when it cannot be had, and the ladder goes on.
 */
export async function suggestKeywords(topic: string, context?: string | null, timeoutMs = 15000): Promise<{ primary: string | null; keywords: string[] }> {
  const empty = { primary: null, keywords: [] as string[] };
  if (!String(topic || '').trim()) return empty;
  const prompt = keywordsPrompt(topic, context);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  try {
    if (anthropicKey) {
      const res = await fetchWithRetry(
        (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: 300, temperature: 0, system: KEYWORDS_SYSTEM, messages: [{ role: 'user', content: prompt }] }),
        },
        { retries: 1, timeoutMs },
      );
      await noteProvider('anthropic', res);
      const data = await res.json();
      return parseKeywords(String(data?.content?.[0]?.text ?? ''));
    }
    if (!openaiKey) return empty;
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', max_tokens: 300, temperature: 0, messages: [{ role: 'system', content: KEYWORDS_SYSTEM }, { role: 'user', content: prompt }] }),
      },
      { retries: 1, timeoutMs },
    );
    await noteProvider('openai', res);
    const data = await res.json();
    return parseKeywords(String(data?.choices?.[0]?.message?.content ?? ''));
  } catch (e) {
    reportError('keywords:suggest', e);
    return empty;
  }
}

/** Thrown by generateContentPack when not even the ladder's last rung found a term. */
export class NoKeywordsError extends Error {
  constructor(topic: string) {
    super('No keywords could be found for "' + String(topic || '').slice(0, 80) + '", so nothing was written: a post is never drafted without keyword research. Give the topic a few more words and try again.');
    this.name = 'NoKeywordsError';
  }
}

/**
 * THE LADDER. Every drafting path gets its keywords here.
 *
 *   1. Semrush — live, the cache, or an expired cache entry (lib/semrush.ts),
 *      on the topic and then on each alternative seed offered.
 *   2. The writer model's own terms for the subject (suggestKeywords).
 *   3. The subject's and the transcript's own words (derivedKeywords).
 *
 * `skipSemrush` is for callers that have already asked Semrush on this
 * request (the video pipeline, the doors): it must not spend units twice.
 * The stamp says which rung answered; `hint` is the prompt block for it.
 */
export async function keywordLadder(
  topic: string,
  opts: { context?: string | null; seeds?: readonly string[]; skipSemrush?: boolean } = {},
): Promise<{ hint?: string; brief: KeywordBrief | null; stamp: SemrushStamp }> {
  let reason: string | undefined;
  if (!opts.skipSemrush) {
    for (const seed of [topic, ...(opts.seeds || [])].map((s) => String(s || '').trim()).filter((s, i, all) => s && all.indexOf(s) === i)) {
      const got = await autoKeywordBrief(seed);
      if (got.stamp.source === 'semrush' && hasKeywords(got.stamp)) return got;
      reason = reason || got.stamp.reason;
    }
  }
  const context = String(opts.context || '') || undefined;
  const modelled = await suggestKeywords(topic, context);
  if (modelled.keywords.length) {
    const stamp = fallbackStamp('model', modelled, reason || 'no_semrush_data') as SemrushStamp;
    return { hint: fallbackBriefPrompt(stamp), brief: null, stamp };
  }
  const derived = derivedKeywords(topic, context);
  const stamp = fallbackStamp(derived.keywords.length ? 'derived' : 'none', derived, reason || 'no_semrush_data') as SemrushStamp;
  return { hint: fallbackBriefPrompt(stamp) || undefined, brief: null, stamp };
}

export async function generateContentPack(
  input: GenerateInput
): Promise<{ provider: Provider; pack: ContentPack; keywordBrief: KeywordBrief | null; semrush: SemrushStamp | null }> {
  const provider: Provider =
    input.provider ||
    (process.env.AI_PROVIDER === 'openai' ? 'openai' : 'anthropic');

  // Mandatory keyword research (unless the caller already did it and hands
  // over its stamp). The ladder never leaves a topic without terms short of a
  // topic with no words in it — and that one is refused, not written blind.
  let keywordBrief: KeywordBrief | null = null;
  let semrush: SemrushStamp | null = input.keywordStamp ?? null;
  if (input.keywordHint === undefined) {
    const auto = await keywordLadder(input.topic, { context: input.keywordContext });
    if (!hasKeywords(auto.stamp)) throw new NoKeywordsError(input.topic);
    input = { ...input, keywordHint: auto.hint };
    keywordBrief = auto.brief;
    semrush = auto.stamp;
  }

  const call = (extra?: string) => {
    const inp = extra ? { ...input, topic: input.topic + '\n\n' + extra } : input;
    return provider === 'openai' ? callOpenAI(inp) : callAnthropic(inp);
  };
  let pack: ContentPack;
  try {
    pack = await call();
  } catch (e) {
    // One retry, for the two failures that are the model having a bad moment
    // rather than anything being wrong with the request.
    //
    // This used to test for malformed JSON alone, which left the throw above —
    // "AI returned no instagram or linkedin copy" — going straight out to the
    // caller as a hard failure. That is the most obviously re-rollable outcome
    // in this file: the request was fine, the model just returned an empty
    // field, and asking once more almost always fills it.
    if (e instanceof Error && /malformed JSON|returned no /i.test(e.message)) {
      // The first answer's own diagnostic goes to the log before the re-roll
      // hides it behind "twice running".
      reportError('ai:writer-first-attempt', e, { provider });
      pack = await call();
    } else {
      throw e;
    }
  }

  // Compliance pass: the AVISO line is appended here (never left to the
  // model), and the REF line's DOI is checked against Crossref. A citation
  // Crossref does not know earns exactly one regeneration; after that the
  // reviewer sees the flag and decides.
  const aviso = avisoNumberFor(input.brand?.aviso_publicidad);
  // The REF line's own title goes with its DOI, so a DOI for a different paper is caught.
  const citedIn = (p: ContentPack) => {
    const c = checkCompliance(p.instagram, aviso).doi ? checkCompliance(p.instagram, aviso) : checkCompliance(p.facebook, aviso);
    return { doi: c.doi, expectedTitle: refTitle(c.ref) };
  };
  const first = citedIn(pack);
  let citation = await verifyDoi(first.doi, { expectedTitle: first.expectedTitle });
  let regenerated = false;
  if (citation.status === 'not_found' || citation.status === 'mismatch') {
    try {
      const again = await call(citation.status === 'mismatch'
        ? 'IMPORTANT: the previous draft cited DOI ' + citation.doi + ', which belongs to a different paper ("' + (citation.title || 'another study') + '"). Cite a real study whose DOI and title match.'
        : 'IMPORTANT: the previous draft cited DOI ' + citation.doi + ', which does not exist. Cite a DIFFERENT real study with a real DOI.');
      const next = citedIn(again);
      const c2 = await verifyDoi(next.doi, { expectedTitle: next.expectedTitle });
      if (c2.status !== 'not_found' && c2.status !== 'mismatch') { pack = again; citation = c2; }
      regenerated = true;
    } catch { /* keep the first draft; the badge tells the reviewer */ }
  }
  // THE AVISO GOES ON EVERY CHANNEL THE RULE COVERS, not two of them.
  //
  // lib/compliance.ts has covered LinkedIn, TikTok and YouTube since September;
  // only this stamping stayed narrow, so those three arrived without the line
  // and were refused at the door. The AVISO is a fixed permit number, not a
  // claim — appending it is bookkeeping, and leaving it off was the bug.
  // `blog` joined them the day the gate started covering articles. Same
  // failure, one format later: the gate widens, the stamping does not, and the
  // copy arrives without the line it is about to be refused for.
  for (const key of ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'blog'] as const) {
    const current = (pack as Record<string, unknown>)[key];
    if (typeof current === 'string' && current.trim()) {
      (pack as Record<string, unknown>)[key] = ensureAviso(current, aviso);
    }
  }

  // AND THE CITATION, ONTO THE CHANNELS THE WRITER WAS NEVER ASKED TO PUT IT ON.
  //
  // REF_INSTRUCTION asks only for the instagram and facebook variants, so a
  // LinkedIn or TikTok draft arrived with no REF line at all and was refused.
  // Copied across rather than asking for a second citation: this one has
  // already been verified against Crossref, and a second would need verifying
  // again. Never invented — if there is no verified citation there is nothing
  // to copy, and the draft is refused as before.
  if (citation.status === 'verified' || citation.status === 'unavailable') {
    const source = checkCompliance(pack.instagram, aviso).ref || checkCompliance(pack.facebook, aviso).ref || '';
    if (source) {
      for (const key of ['linkedin', 'tiktok', 'youtube', 'blog'] as const) {
        const current = (pack as Record<string, unknown>)[key];
        if (typeof current === 'string' && current.trim() && !checkCompliance(current, aviso).doi) {
          (pack as Record<string, unknown>)[key] = ensureAviso(current.replace(/\s+$/, '') + '\n\nREF: ' + source, aviso);
        }
      }
    }
  }
  const refPolicy: RefPolicy = input.citationPolicy === 'if-health-claim' ? 'if-health-claim' : 'required';
  const igCheck = checkCompliance(pack.instagram, aviso, { refPolicy });
  const fbCheck = checkCompliance(pack.facebook, aviso, { refPolicy });
  // No REF line, and none needed: said as such rather than as "no DOI", which
  // every gate downstream would read as a citation to go and fix.
  if (citation.status === 'no_doi' && refPolicy === 'if-health-claim' && igCheck.refWaived && (fbCheck.refWaived || !String(pack.facebook || '').trim())) {
    citation = { status: 'not_required', doi: null, title: null, year: null };
  }
  const stamp: ComplianceStamp = {
    aviso,
    instagram: igCheck,
    facebook: fbCheck,
    citation,
    regenerated,
    refPolicy,
  };
  (pack as ContentPack & { _compliance?: ComplianceStamp })._compliance = stamp;

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
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1024, system: ASSISTANT_SYSTEM, messages: trimmed }),
    });
    await noteProvider('anthropic', res);
    const data = await res.json();
    return String(data?.content?.[0]?.text ?? '').trim();
  }
  if (!openaiKey) throw new Error('No AI provider key configured');
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'system', content: ASSISTANT_SYSTEM }, ...trimmed] }),
  });
  await noteProvider('openai', res);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}


// ---------------------------------------------------------------------------
// Does the paper back the claim?
//
// Everything about a citation was checked except the only thing that matters on
// an advertisement: whether the study supports the sentence printed above it.
// The papers and their abstracts are already in memory by the time the copy
// exists (lib/video-prepare.ts), so this costs one short call and no new
// research. The question, the prompt and the parsing live in
// lib/claim-support.ts, where they can be tested; this is the wire.
// ---------------------------------------------------------------------------

/**
 * Ask which of these papers supports this copy.
 *
 * FAILS OPEN, DELIBERATELY. Every transport failure — no key, a 500, a timeout,
 * a refusal, prose instead of JSON — returns 'unchecked', and the caller then
 * behaves exactly as it did before this check existed. The same call the
 * codebase already makes for an unreachable Crossref (lib/citation.ts returns
 * 'unavailable', and lib/video-prepare.ts accepts the DOI anyway): a service
 * being down is not evidence about a paper, and must never be the reason a
 * clinic cannot publish.
 */
export async function judgeClaimSupport(args: {
  claim: string;
  items: readonly EvidenceItem[];
  timeoutMs?: number;
}): Promise<SupportVerdict> {
  const items = (args.items || []).slice(0, MAX_CANDIDATES);
  const claim = String(args.claim || '').trim();
  // Nothing to judge is not a failure of judgement.
  if (!claim || !items.length) return { status: 'unchecked' };

  const timeoutMs = args.timeoutMs ?? 12000;
  const prompt = supportPrompt(claim, items);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  try {
    if (anthropicKey) {
      const res = await fetchWithRetry(
        (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
            // One line of JSON. A ceiling this low also stops a model that has
            // decided to explain itself from spending a minute doing so.
            max_tokens: 64,
            // Zero, not 0.4. This is a verdict on a medical claim, and the same
            // copy against the same abstracts must not come out differently on
            // a second prepare.
            temperature: 0,
            system: JUDGE_SYSTEM,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        // One retry, not two: this is an extra check inside a request budget
        // that already has a transcript and two drafts to pay for.
        { retries: 1, timeoutMs },
      );
      await noteProvider('anthropic', res);
      const data = await res.json();
      return parseSupportVerdict(String(data?.content?.[0]?.text ?? ''), items.length);
    }
    if (!openaiKey) return { status: 'unchecked' };
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 64,
          temperature: 0,
          messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: prompt }],
        }),
      },
      { retries: 1, timeoutMs },
    );
    await noteProvider('openai', res);
    const data = await res.json();
    return parseSupportVerdict(String(data?.choices?.[0]?.message?.content ?? ''), items.length);
  } catch (e) {
    reportError('claim-support:judge', e);
    return { status: 'unchecked' };
  }
}

// ---------------------------------------------------------------------------
// The title, written from what was said.
//
// The words are already here — the transcript that produced the copy, and the
// copy itself — so this is one short call with no new research. The answer is
// a SUGGESTION: lib/post-title.ts still refuses a name from the strip list,
// adds the clinic once, and falls through to the rung below when the model
// returns nothing usable.
// ---------------------------------------------------------------------------

/**
 * Ask for one title. Never throws; returns '' when it cannot be had.
 *
 * Fails open exactly like judgeClaimSupport above: no key, a timeout, a 500,
 * prose instead of a title — all of them are '', and the caller then titles the
 * post the way it did before this existed.
 */
export async function writeTitle(args: {
  copy?: string | null;
  transcript?: string | null;
  subject?: string | null;
  timeoutMs?: number;
}): Promise<string> {
  const prompt = titlePrompt(args);
  // Nothing to read means nothing to title.
  if (!String(args.copy || '').trim() && !String(args.transcript || '').trim()) return '';

  const timeoutMs = args.timeoutMs ?? 12000;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  try {
    if (anthropicKey) {
      const res = await fetchWithRetry(
        (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
            // Six words. A ceiling this low also stops a model that has decided
            // to explain its choice from spending the caller's clock doing so.
            max_tokens: 48,
            // A little room to pick the better of two phrasings, and no more:
            // the same video prepared twice should not get unrelated titles.
            temperature: 0.2,
            system: TITLE_SYSTEM,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        { retries: 1, timeoutMs },
      );
      await noteProvider('anthropic', res);
      const data = await res.json();
      return readTitle(String(data?.content?.[0]?.text ?? ''));
    }
    if (!openaiKey) return '';
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 48,
          temperature: 0.2,
          messages: [{ role: 'system', content: TITLE_SYSTEM }, { role: 'user', content: prompt }],
        }),
      },
      { retries: 1, timeoutMs },
    );
    await noteProvider('openai', res);
    const data = await res.json();
    return readTitle(String(data?.choices?.[0]?.message?.content ?? ''));
  } catch (e) {
    reportError('title:write', e);
    return '';
  }
}

// ---------------------------------------------------------------------------
// The checkable statements in a post (lib/claim-extract.ts), for "Verify / fix".
// ---------------------------------------------------------------------------

/**
 * Take a post apart into the statements a study could back, each with its own
 * PubMed query. Never throws; returns [] when it cannot be had, and the caller
 * then falls back to judging the post whole, as before.
 */
/** One short editing call to whichever model is configured. Raw text, or null when none answered. */
async function editWithModel(system: string, prompt: string, maxTokens: number, timeoutMs: number, tag: string): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  try {
    if (anthropicKey) {
      const res = await fetchWithRetry(
        (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: prompt }] }),
        },
        { retries: 1, timeoutMs },
      );
      await noteProvider('anthropic', res);
      const data = await res.json();
      return typeof data?.content?.[0]?.text === 'string' ? data.content[0].text : null;
    }
    if (!openaiKey) return null;
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', max_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      },
      { retries: 1, timeoutMs },
    );
    await noteProvider('openai', res);
    const data = await res.json();
    return typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : null;
  } catch (e) {
    reportError(tag, e);
    return null;
  }
}

/**
 * "Fix citation": the post's overclaiming sentences rewritten to what this
 * study reports, everything else kept, and the study cited
 * (lib/claim-rewrite.ts). Null when no model answered or the answer is not one
 * to take (acceptRewrite) — the caller then leaves the post as it is.
 */
export async function rewriteClaimToStudy(text: string, study: StudyForRewrite, timeoutMs = 45_000, opts: { strict?: boolean } = {}): Promise<string | null> {
  const copy = String(text || '').trim();
  if (!copy) return null;
  const raw = await editWithModel(opts.strict ? CLAIM_REWRITE_STRICT_SYSTEM : CLAIM_REWRITE_SYSTEM, claimRewritePrompt(copy, study), 4000, timeoutMs, 'ai:rewrite-claim');
  return raw == null ? null : acceptRewrite(copy, raw, study.ref);
}

/** Is this study about what the post talks about? null when the model did not say. */
export async function studyOnTopic(text: string, study: StudyForRewrite, timeoutMs = 15_000): Promise<boolean | null> {
  const raw = await editWithModel(RELEVANCE_SYSTEM, relevancePrompt(text, study), 20, timeoutMs, 'ai:study-on-topic');
  return raw == null ? null : parseRelevance(raw);
}

/**
 * No study on the post's subject: the post rewritten to claim nothing and
 * carry no citation. Returns the accepted text, or the words that still read
 * as a claim so the caller can ask once more.
 */
export async function rewriteWithoutClaims(text: string, flagged: readonly string[] = [], timeoutMs = 45_000, sentences: readonly string[] = []): Promise<{ text: string | null; flagged: string[] }> {
  const copy = String(text || '').trim();
  if (!copy) return { text: null, flagged: [] };
  const raw = await editWithModel(NO_CLAIM_SYSTEM, noClaimPrompt(copy, flagged, sentences), 4000, timeoutMs, 'ai:rewrite-no-claim');
  return raw == null ? { text: null, flagged: [] } : acceptNoClaim(copy, raw);
}

export async function extractCheckableClaims(text: string, timeoutMs = 15000): Promise<CheckableClaim[]> {
  const copy = String(text || '').trim();
  if (!copy) return [];
  const prompt = claimsPrompt(copy);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  try {
    if (anthropicKey) {
      const res = await fetchWithRetry(
        (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
            max_tokens: 400,
            // The same post must come apart the same way twice.
            temperature: 0,
            system: CLAIMS_SYSTEM,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        { retries: 1, timeoutMs },
      );
      await noteProvider('anthropic', res);
      const data = await res.json();
      return parseClaims(String(data?.content?.[0]?.text ?? ''));
    }
    if (!openaiKey) return [];
    const res = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 400,
          temperature: 0,
          messages: [{ role: 'system', content: CLAIMS_SYSTEM }, { role: 'user', content: prompt }],
        }),
      },
      { retries: 1, timeoutMs },
    );
    await noteProvider('openai', res);
    const data = await res.json();
    return parseClaims(String(data?.choices?.[0]?.message?.content ?? ''));
  } catch (e) {
    reportError('claim-extract', e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agentic assistant: lets the chatbot take real actions via tool-calling.
// chatWithTools() runs one Anthropic turn where the model may request a tool.
// It does NOT execute anything itself; it returns the requested action so the
// server (assistant route) can run it with the authed user + confirmation gate.
// ---------------------------------------------------------------------------

export type ToolName =
  | "generate_content"
  | "save_draft"
  | "schedule_post"
  | "clip_video"
  | "research_topic"
  | "keyword_lookup"
  | "pipeline_status"
  | "retry_video"
  | "list_schedule"
  | "create_schedule"
  | "update_schedule"
  | "pause_schedule"
  | "draft_batch"
  | "generate_image"
  | "competitor_comparables";

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

You are fully aware of the workspace: the LIVE SITUATION and WORKSPACE blocks tell you, on every turn, what state the video pipeline is in, what is on the calendar, what the Autopilot has waiting for review, what drafts exist and what the planner is doing; WHERE THE USER IS tells you which screen they are on, so "what needs me?" is answered about that screen first; WHAT HAS WORKED tells you which posts, networks, times and keywords have performed for this brand, and the CLINIC PROFILE is the Brand Brain. Answer from them. When choosing what to write, where to post it or when, prefer what has worked and say the numbers; when nothing is known to have worked, say so. ${CAN_DO_RULE} ${COMMAND_ONLY_RULES} ${NEXT_STEP_RULE} ${CONVERSATION_RULE}

Tool guidance:
- generate_content: produce a ready-to-post content pack for a topic. Use this first when the user wants a post/article/email/etc. Infer a sensible format (social/blog/email/video/ad) from the request.
- save_draft: save a generated pack to the drafts feed. Call after generate_content when the user wants to keep or later schedule the content.
- schedule_post: schedule a post to a social network at a date/time via the connected scheduler. Networks: facebook, instagram, linkedin, twitter (x), tiktok, youtube, threads. publishAt must be an ISO datetime (YYYY-MM-DDTHH:MM). The server will ask the user to confirm before anything goes live, so it is fine to call this when the user asks; do not refuse.
- clip_video: turn a long YouTube or Vimeo video into short vertical clips via OpusClip. Use when the user gives a video URL and asks for clips/shorts/reels. Requires a videoUrl; title and language are optional.
- research_topic: run topic research (angles, keywords, hashtags, hooks, and a ready draft) for a network. Use when the user asks to research a topic or wants ideas/angles/keywords before drafting. Requires a topic; network is optional (default instagram).
- pipeline_status: list the clinic's videos and what state each is in — done, queued, stuck, or waiting on a person, and for each whether it has a shareable copy (so it CAN carry its video) and whether a Metricool draft already exists for it. Call it whenever the user asks what happened to a video, what needs them, what is stuck, or whether something is ready to send. The LIVE SITUATION block already gives you the headline; use this for detail or when the user asks about a specific video.
- retry_video: re-run a video that stopped. Use it for anything the situation block marks [retry_video can fix this]. It clears the row's attempt count — which is the only way a video that has already been retired gets another chance — then re-transcribes and rewrites the copy and puts it back in the Google Sheet.
- list_schedule: show the planner — every schedule template, when each fires, what subject it draws from, and how many slots are planned ahead. Call this BEFORE answering any question about the planner or the posting schedule, and before creating a template, so you are describing what exists rather than what you assume.
- create_schedule / update_schedule: build or change a template. One template produces at most one post per weekday at its own time_of_day, so SEVERAL POSTS A DAY MEANS SEVERAL TEMPLATES — same weekdays, different time_of_day, each with its own strategy.pillars or strategy.topic. When the user asks for more than one blog a day, explain that shape AND offer to create the templates; if they say yes, create them, one call each.
- pause_schedule: turn a template off without deleting it, keeping its history.
- draft_batch: write a whole set of posts and queue every one as a Metricool DRAFT for the user to approve. Propose the list first — topics, networks, dates — and call this only once the user has agreed to the BATCH. Each item is researched, written in the clinic's voice, checked against the advertising rules, saved to drafts, and queued as a draft. Nothing publishes.
- competitor_comparables: who ranks #1, #2 and #3 on Google for a topic, what each of them is doing (their page, its angle, the searches they own), and a MIRROR POST: one proposition in the clinic's voice that does what the top results do, ready to copy and paste or for you to draft with generate_content. Call it when the user asks how they compare, what the competition is doing, or for a post like the leaders'; and OFFER it (the "Next:" line) whenever a draft has just been written or the user says they are finishing or about to send one.
- generate_image: make (or remake) the picture for a draft — the one just written and saved, or a saved draft named by its id from the WORKSPACE block. Use it when the user asks for an image, a picture, a visual or a cover. It costs a credit, so call it once per request, not speculatively.
- keyword_lookup: fetch REAL Semrush search data for a topic — monthly volume, keyword difficulty (KD), CPC, searcher intent, and the questions people actually ask. Call this BEFORE recommending topics, angles, or keywords, and whenever the user asks what to write about or how content might perform.

Semrush grounding rules: recommendations about WHAT to write must be grounded in keyword_lookup or research_topic data, not guesses. Prefer high-volume, lower-difficulty (KD under ~60) terms; say the numbers out loud (e.g. "1,900 searches/mo, KD 26") so the user can judge; when data is unavailable, say so plainly rather than inventing metrics.

What you may do when told, and what you may never do:
- When the user tells you to retry, re-prepare or rewrite a video, do it — as many as they name — and write the caption into the Google Sheet, then say what happened. Never do it unasked, and never offer it unasked: report what is stuck and wait.
- When the user asks for a schedule, create, change and pause templates. Do it rather than describing how they could.
- You MAY queue Metricool DRAFTS with draft_batch — but ask once for the BATCH first. Show the list you intend to write (topics, networks, dates), get a yes, then run it. Never queue a batch nobody asked for, and never expand one you were given.
- You may NEVER publish anything, or ask for anything to be published. NONE of the tools you have can publish: every one of them stops at a draft in Metricool, and a person presses Approve there. (Elsewhere in this dashboard a human approving a run can choose to schedule it live — that is their button, not yours, and you never have it.) Say so plainly when someone asks you to "post" something.
- A draft refused by the advertising check is REPORTED, never quietly reworded and queued anyway. Say which rule it failed. Never invent an AVISO number or a REF citation to get past the check.
- retry_video deliberately queues nothing at all, and will tell you so; that is separate from draft_batch and is not a rule you can route around by calling the other one.
- Never claim a video was fixed unless the tool result says so. A tool that reports "still needs a transcript" means a person has to paste one; say that plainly instead of offering to try again.
- When the LIVE SITUATION says the pipeline could not be read, you do not know how many videos are done, queued or stuck. Say that, and do not answer from the counts.

Keep replies concise and friendly — one thing at a time, plain words, no lists of everything you could do. Only reference the clinic own website and YouTube content. Never invent medical claims; keep language compliant and non-exaggerated. If a scheduling request is missing the network or the date/time, ask a brief clarifying question instead of calling schedule_post.`;

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
    name: "pipeline_status",
    description: "List the clinic's videos and the state each one is in: done, queued, being worked on, stuck on something temporary, or waiting on a person. Use for 'what happened to that video', 'what needs me', 'what is stuck'.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "stuck", "recent"], description: "Which rows to list. Default stuck." },
      },
      required: [],
    },
  },
  {
    name: "retry_video",
    description: "Re-run a video that stopped, clearing its attempt count first so that even a row which had been retired for good is tried again. Re-transcribes if needed, rewrites the copy and writes it into the Google Sheet. It NEVER queues anything to Metricool — that stays a button the user presses.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The row id from pipeline_status. Preferred." },
        title: { type: "string", description: "The video's title, if the id is not known." },
        all_stuck: { type: "boolean", description: "Retry every video stuck on something temporary, instead of one. Capped per turn." },
      },
      required: [],
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
    name: "list_schedule",
    description: "Show the planner: every schedule template (when it fires, what subject it draws from, whether it is active) and how many slots are planned ahead. Call before answering anything about the posting schedule, and before creating a template.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_schedule",
    description: "Create one schedule template. A template fires at most once per weekday, at its time_of_day — so three blogs a day means calling this three times with three different times.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name a person will recognise, e.g. 'Morning blog — joints'." },
        weekdays: { type: "array", items: { type: "number" }, description: "0=Sunday .. 6=Saturday." },
        time_of_day: { type: "string", description: "24-hour HH:MM, clinic-local (America/Cancun). Anything else falls back to 09:00." },
        providers: { type: "array", items: { type: "string" }, description: "Networks this template posts to." },
        format: { type: "string", enum: ["social", "blog", "email", "video", "ad"], description: "What each occurrence produces. Use 'blog' for blog posts." },
        mode: { type: "string", enum: ["off", "fixed_topic", "pillars", "auto"], description: "'pillars' rotates through a subject list; 'fixed_topic' always writes the same subject; 'off' is a static template Autopilot ignores." },
        topic: { type: "string", description: "The subject, when mode is fixed_topic." },
        pillars: { type: "array", items: { type: "string" }, description: "The subjects to rotate through, when mode is pillars. Max 12." },
        goal: { type: "string", enum: ["rank", "traffic", "engagement", "authority"], description: "What each occurrence is optimised for. Default rank." },
      },
      required: ["name", "weekdays", "time_of_day"],
    },
  },
  {
    name: "update_schedule",
    description: "Change an existing schedule template. Give the id from list_schedule and ONLY the fields you are changing — everything you leave out keeps its current value. Do not resend a whole template from memory: a field you mis-remember overwrites the stored one.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The template id from list_schedule." },
        name: { type: "string" },
        weekdays: { type: "array", items: { type: "number" } },
        time_of_day: { type: "string" },
        providers: { type: "array", items: { type: "string" } },
        format: { type: "string", enum: ["social", "blog", "email", "video", "ad"] },
        mode: { type: "string", enum: ["off", "fixed_topic", "pillars", "auto"] },
        topic: { type: "string" },
        pillars: { type: "array", items: { type: "string" } },
        goal: { type: "string", enum: ["rank", "traffic", "engagement", "authority"] },
      },
      required: ["id"],
    },
  },
  {
    name: "pause_schedule",
    description: "Turn a schedule template off (or back on) without deleting it, so its history survives.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The template id from list_schedule." },
        active: { type: "boolean", description: "false to pause, true to resume. Default false." },
      },
      required: ["id"],
    },
  },
  {
    name: "draft_batch",
    description: "Write a whole set of posts and queue each as a Metricool DRAFT awaiting the user's approval. Propose the list in words first and call this only after the user agrees to the batch. Nothing publishes.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The posts to write. At most 10 per batch.",
          items: {
            type: "object",
            properties: {
              topic: { type: "string", description: "What this post is about." },
              network: { type: "string", enum: ["facebook", "instagram", "linkedin", "twitter", "x", "tiktok", "youtube", "threads"] },
              publishAt: { type: "string", description: "ISO datetime YYYY-MM-DDTHH:MM in the clinic timezone. Must be in the future." },
              format: { type: "string", enum: ["social", "blog", "email", "video", "ad"] },
            },
            required: ["topic", "network", "publishAt"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "competitor_comparables",
    description: "Who ranks #1-#3 on Google for a topic, what each is doing, and the material for a mirror post in the clinic's voice. Real Semrush data; costs units only when not cached.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The search phrase or subject to compare on — the draft's primary keyword when there is one." },
        network: { type: "string", description: "Where the post would go, so the proposition fits it. Optional." },
      },
      required: ["topic"],
    },
  },
  {
    name: "generate_image",
    description: "Make (or remake) the picture for a draft: the draft just written in this conversation, or a saved draft by id. Costs one image credit. Returns the picture's URL.",
    input_schema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "A saved draft's id (from the WORKSPACE block). Omit for the draft written in this conversation." },
        fresh: { type: "boolean", description: "true to make a new picture even when the draft already has one." },
        notes: { type: "string", description: "What the picture should show, when the user said." },
      },
      required: [],
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

/**
 * @param systemExtra live facts about THIS user's workspace, appended as a
 *   second system block rather than concatenated into the first. Two reasons:
 *   the static half stays byte-identical turn to turn (so it can be prompt-
 *   cached later without a rewrite), and the model sees a clearly delimited
 *   "here is the situation right now" rather than a prompt that looks edited.
 */
export async function chatWithTools(
  messages: ToolMessage[],
  systemExtra?: string,
  opts: {
    tools?: boolean;
    /**
     * Given, the answer is streamed and each piece of its text is handed here
     * as it arrives, so the panel shows the sentence being written instead
     * of "Working…" until the whole paragraph is done. The turn returned is
     * the same either way.
     */
    onText?: (delta: string) => void;
  } = {},
): Promise<ToolTurn> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const streaming = typeof opts.onText === "function";
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
      // Three blocks, in order of how often they change, with the cache break
      // after the second.
      //
      // The static half is TOOLS_SYSTEM plus the playbook: byte-identical on
      // every turn of every conversation, and about 2,000 tokens that were
      // being re-sent on each of up to four tool-loop iterations per message.
      // `systemExtra` changes every turn by design (it carries the live
      // situation), so anything static concatenated into it can never be
      // cached — which is exactly what putting the playbook in there did.
      system: [
        { type: 'text', text: TOOLS_SYSTEM },
        { type: 'text', text: PLAYBOOK, cache_control: { type: 'ephemeral' } },
        // A second break after the live block: it changes every MESSAGE, but
        // not between the up-to-four model calls one message's tool loop
        // makes, and those were re-reading it in full each time.
        ...(systemExtra ? [{ type: 'text', text: systemExtra, cache_control: { type: 'ephemeral' } }] : []),
      ],
      // On standby the tools are withheld, not merely forbidden in prose: a
      // model that cannot call retry_video cannot retry a video.
      ...(opts.tools === false ? {} : { tools: TOOL_DEFS }),
      messages,
      ...(streaming ? { stream: true } : {}),
    }),
  });
  await noteProvider('anthropic', res);
  if (streaming) {
    const turn = await readAnthropicToolStream(res, opts.onText!);
    return {
      message: turn.text.trim(),
      toolCall: turn.toolCall ? { name: turn.toolCall.name as ToolName, input: turn.toolCall.input as Record<string, any> } : null,
      toolUseId: turn.toolCall ? turn.toolCall.id : null,
    };
  }
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
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2048, system: RESEARCH_SYSTEM, messages: [{ role: 'user', content: userPrompt }] }),
    }, { retries: 0, timeoutMs: 50000 });
    await noteProvider('anthropic', res);
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
    await noteProvider('openai', res);
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

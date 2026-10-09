// web/lib/title-suggest.ts
// Three alternative cover titles for a post — a small TEXT call, never an
// image one, so the Edit image panel can offer other words for free.
//
// Fails open like lib/ai.ts writeTitle: no key, a timeout, prose instead of a
// list — all of them fall back to the planner's own framings
// (lib/cover-edit.ts fallbackTitles), so the row is never empty.
import 'server-only';
import { reportError } from '@/lib/report';
import { fallbackTitles, parseTitleList, SUGGEST_TITLES_SYSTEM, suggestTitlesPrompt } from './cover-edit.ts';

type TitleInput = {
  angle: string;
  pillarName?: string | null;
  copy?: string | null;
  current?: string | null;
  avoid?: readonly string[];
  timeoutMs?: number;
};

/**
 * THE title a cover gets, written from the post in the feed's voice
 * (lib/cover-edit.ts TITLE_STYLE_EXAMPLES). Null when no model answered —
 * the caller falls back to the static title it always had.
 */
export async function writeCoverTitle(input: TitleInput): Promise<string | null> {
  const avoid = [...(input.avoid || [])].filter(Boolean);
  try {
    const titles = await askTitles(suggestTitlesPrompt({ ...input, count: 1 }), 1, avoid, input.timeoutMs);
    return titles[0] || null;
  } catch (e) {
    reportError('title-write', e, { angle: input.angle });
    return null;
  }
}

export async function suggestCoverTitles(input: TitleInput): Promise<string[]> {
  const avoid = [String(input.current || ''), ...(input.avoid || [])].filter(Boolean);
  const fallback = () => fallbackTitles(String(input.current || input.angle || ''));
  try {
    const titles = await askTitles(suggestTitlesPrompt(input), 3, avoid, input.timeoutMs);
    // Fill up from the framings when the model offered fewer than three.
    for (const t of fallback()) {
      if (titles.length >= 3) break;
      if (!titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t);
    }
    return titles;
  } catch (e) {
    reportError('title-suggest', e, { angle: input.angle });
    return fallback();
  }
}

/** One text call, either provider; throws when neither is configured or the call fails. */
async function askTitles(prompt: string, max: number, avoid: string[], timeoutMs?: number): Promise<string[]> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) throw new Error('no text model configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 12_000);
  try {
    let raw = '';
    if (anthropicKey) {
      const res = await fetch((process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
          max_tokens: 120,
          temperature: 0.7,
          system: SUGGEST_TITLES_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}`);
      const data = await res.json();
      raw = String(data?.content?.[0]?.text ?? '');
    } else {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 120,
          temperature: 0.7,
          messages: [{ role: 'system', content: SUGGEST_TITLES_SYSTEM }, { role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const data = await res.json();
      raw = String(data?.choices?.[0]?.message?.content ?? '');
    }
    return parseTitleList(raw, { max, avoid });
  } finally {
    clearTimeout(timer);
  }
}

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

export async function suggestCoverTitles(input: {
  angle: string;
  pillarName?: string | null;
  copy?: string | null;
  current?: string | null;
  avoid?: readonly string[];
  timeoutMs?: number;
}): Promise<string[]> {
  const avoid = [String(input.current || ''), ...(input.avoid || [])].filter(Boolean);
  const fallback = () => fallbackTitles(String(input.current || input.angle || ''));
  const prompt = suggestTitlesPrompt(input);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return fallback();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);
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
    const titles = parseTitleList(raw, { max: 3, avoid });
    // Fill up from the framings when the model offered fewer than three.
    for (const t of fallback()) {
      if (titles.length >= 3) break;
      if (!titles.some((x) => x.toLowerCase() === t.toLowerCase())) titles.push(t);
    }
    return titles;
  } catch (e) {
    reportError('title-suggest', e, { angle: input.angle });
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

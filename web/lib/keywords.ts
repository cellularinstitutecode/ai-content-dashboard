// web/lib/keywords.ts
// Compatibility layer over lib/semrush.ts (the Semrush Brain).
//
// Older callers (e.g. /api/keywords) use researchKeywords()/keywordHintFrom().
// Both now run through the cached, budget-guarded Semrush client, so every
// path in the app spends units at most once per topic per cache window.

import { relatedKeywords, type SemKeyword } from '@/lib/semrush';
import type { SemrushReason } from '@/lib/semrush-reason';

export type KeywordMetric = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
};

export type KeywordResearch = {
  ok: boolean;
  source: 'semrush' | 'none';
  topic: string;
  keywords: KeywordMetric[];
  note?: string;
  reason?: SemrushReason;
  upstreamStatus?: number | null;
};

export async function researchKeywords(
  topic: string,
  opts: { limit?: number; database?: string } = {}
): Promise<KeywordResearch> {
  const seed = (topic || '').trim();
  if (!seed) return { ok: false, source: 'none', topic: seed, keywords: [], note: 'empty topic', reason: 'empty', upstreamStatus: null };
  const r = await relatedKeywords(seed, { limit: opts.limit ?? 12, database: opts.database });
  const keywords: KeywordMetric[] = r.rows.map((k: SemKeyword) => ({
    keyword: k.keyword,
    volume: k.volume,
    difficulty: k.difficulty,
    cpc: k.cpc,
  }));
  if (!r.ok) {
    return { ok: false, source: 'none', topic: seed, keywords: [], note: r.note || 'Semrush unavailable', reason: r.reason, upstreamStatus: null };
  }
  if (!keywords.length) {
    return { ok: false, source: 'semrush', topic: seed, keywords: [], note: 'no keywords returned', reason: 'ok', upstreamStatus: 200 };
  }
  return { ok: true, source: 'semrush', topic: seed, keywords, reason: 'ok', upstreamStatus: 200 };
}

// Compact prompt hint (legacy shape) + the list actually applied.
export function keywordHintFrom(research: KeywordResearch, max = 8): { hint: string; applied: string[] } {
  if (!research.ok || !research.keywords.length) return { hint: '', applied: [] };
  const top = research.keywords.slice(0, max);
  const applied = top.map((k) => k.keyword);
  const lines = top
    .map((k) => {
      const v = k.volume != null ? k.volume + '/mo' : 'n/a';
      const d = k.difficulty != null ? 'KD ' + k.difficulty : 'KD n/a';
      return '- ' + k.keyword + ' (' + v + ', ' + d + ')';
    })
    .join('\n');
  const hint =
    'SEO keyword research (Semrush) for this topic. Naturally work the ' +
    'highest-value, lower-difficulty terms into the copy, hashtags and headings ' +
    'where they fit — do not keyword-stuff:\n' +
    lines;
  return { hint, applied };
}

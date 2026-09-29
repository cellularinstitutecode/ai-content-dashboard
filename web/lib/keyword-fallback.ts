// web/lib/keyword-fallback.ts
// Keywords when Semrush has none: the fallbacks, and the words around them.
//
// THE AUDIT. Rows in the sheet read "Listo — SIN keywords": the copy was
// written, the keyword column was empty, and the post went on to Metricool
// like any other. autoKeywordBrief's own comment said "keyword research must
// NEVER block generation", and it did not — it simply let the post go with
// nothing behind it, whenever Semrush was out of units, unreachable, had no
// row for a filename, or was never configured.
//
// The rule now: nothing is written without keywords, and no post goes out
// without them. Semrush first — live, then the cache, then a cache entry
// that has expired (old search data is still search data). When Semrush has
// nothing at all, the writer model is asked for the terms people would
// search, and failing even that, the terms are taken from the subject and
// the transcript themselves. Each rung is stamped with its source, so a
// person can see which posts were written to real volumes and which to
// estimates — and the sheet says "keywords estimadas", not "SIN keywords".
//
// Pure: relative imports only, so the test runner reads this file directly.
import { frequentTerms, terms } from './evidence-query.ts';

export type KeywordSource = 'semrush' | 'model' | 'derived' | 'none';

/** The stamp every drafting path writes onto the pack as `_semrush`. Structural twin of lib/ai.ts SemrushStamp. */
export type KeywordStamp = {
  checked: boolean;
  source: KeywordSource;
  primary: string | null;
  volume: number | null;
  difficulty: number | null;
  keywords: string[];
  questions: string[];
  intent: string | null;
  fromCache: boolean;
  unitsSpent: number;
  reason?: string;
  checkedAt: string;
};

export const MAX_FALLBACK_KEYWORDS = 8;

export const KEYWORDS_SYSTEM =
  'You are an SEO strategist for a physician-led regenerative medicine clinic. Live search data is unavailable. ' +
  'Given a topic (and sometimes the words actually spoken about it), name the search terms people type when looking ' +
  'for this subject: one primary phrase and up to seven supporting ones. Plain phrases of one to five words, no ' +
  'quotes, no hashtags, no punctuation, no medical claims, nothing shopping-shaped ("near me", "cost", "price"). ' +
  'Answer with ONE line of JSON and nothing else: {"primary":"...","keywords":["...","..."]}. Do not explain.';

export function keywordsPrompt(topic: string, context?: string | null): string {
  const c = String(context || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return 'TOPIC: ' + String(topic || '').trim() + (c ? '\n\nWHAT IS SAID ABOUT IT:\n' + c : '') + '\n\n{"primary":"...","keywords":[...]}';
}

function cleanTerm(raw: unknown): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[#"'()[\]{}:;,.!?*+~^|\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function usable(t: string): boolean {
  const words = t.split(' ').filter(Boolean);
  return t.length >= 3 && words.length >= 1 && words.length <= 6 && !/\b(near me|cerca de m[ií]|price|prices|cost|costs)\b/.test(t);
}

/** The model's answer, read without guessing: prose, fences or junk parse to nothing. */
export function parseKeywords(text: string | null | undefined): { primary: string | null; keywords: string[] } {
  const raw = String(text || '').trim();
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return { primary: null, keywords: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return { primary: null, keywords: [] }; }
  if (!parsed || typeof parsed !== 'object') return { primary: null, keywords: [] };
  const p = parsed as { primary?: unknown; keywords?: unknown };
  const out: string[] = [];
  const push = (v: unknown) => { const t = cleanTerm(v); if (t && usable(t) && !out.includes(t) && out.length < MAX_FALLBACK_KEYWORDS) out.push(t); };
  push(p.primary);
  if (Array.isArray(p.keywords)) p.keywords.forEach(push);
  return { primary: out[0] || null, keywords: out };
}

/**
 * The last rung: terms from the subject and what was said about it.
 *
 * The subject line is the primary phrase (cleaned, at most six words), and
 * the supporting terms are what the transcript or brief keeps coming back to
 * (lib/evidence-query.ts frequentTerms) — the same vocabulary the evidence
 * search is built from, so the two agree about what the post is about.
 */
export function derivedKeywords(topic: string, context?: string | null): { primary: string | null; keywords: string[] } {
  const subjectWords = terms(topic).slice(0, 6);
  const primary = subjectWords.join(' ');
  const out: string[] = [];
  if (primary && usable(primary)) out.push(primary);
  const spoken = context ? frequentTerms(context, 8) : [];
  for (const w of [...spoken, ...subjectWords]) {
    if (out.length >= MAX_FALLBACK_KEYWORDS) break;
    if (w.length >= 4 && !out.includes(w)) out.push(w);
  }
  return { primary: out[0] || null, keywords: out };
}

export function fallbackStamp(source: 'model' | 'derived' | 'none', found: { primary: string | null; keywords: string[] }, reason?: string): KeywordStamp {
  return {
    checked: true,
    source: found.keywords.length ? source : 'none',
    primary: found.primary,
    volume: null,
    difficulty: null,
    keywords: found.keywords,
    questions: [],
    intent: null,
    fromCache: false,
    unitsSpent: 0,
    reason,
    checkedAt: new Date().toISOString(),
  };
}

/** Does this stamp carry anything a post can be written to, from any source? */
export function hasKeywords(stamp: { keywords?: string[] | null } | null | undefined): boolean {
  return Array.isArray(stamp?.keywords) && stamp!.keywords.some((k) => String(k || '').trim());
}

/**
 * The prompt block for keywords that did not come from Semrush.
 *
 * The same contract as briefPromptFrom (lib/keyword-brief.ts) — in the body,
 * never leading, never stuffed — and honest about what these are: chosen, not
 * measured, so the model is not told to "match searcher intent" it cannot know.
 */
export function fallbackBriefPrompt(stamp: { source: KeywordSource; primary: string | null; keywords: string[] }): string {
  if (!stamp.keywords.length || stamp.source === 'semrush' || stamp.source === 'none') return '';
  const primary = stamp.primary || stamp.keywords[0];
  const supporting = stamp.keywords.filter((k) => k !== primary);
  const lines = [
    'KEYWORD BRIEF (no live search data — these terms were ' + (stamp.source === 'model' ? 'chosen for this subject' : 'taken from the subject and the transcript') + '; follow this contract):',
    '- PRIMARY keyword: ' + primary + '. Work it into the BODY 2-3 times where it reads naturally.',
    '- The opening line is NOT the keyword’s. Never open with the primary keyword or any search phrase; write the first sentence from the subject itself, or from what the speaker actually says.',
  ];
  if (supporting.length) lines.push('- SUPPORTING terms (each once where natural, never in the first line): ' + supporting.join('; '));
  lines.push('- Never keyword-stuff; keep medical claims compliant and non-exaggerated.');
  return lines.join('\n');
}

/** The sentence beside a draft, for where its keywords came from. */
export function keywordSourceNote(stamp: { source?: string | null; keywords?: string[] | null; reason?: string | null } | null | undefined): string {
  const keywords = (stamp?.keywords || []).filter(Boolean);
  switch (stamp?.source) {
    case 'semrush': return '';
    case 'model': return 'Keywords estimated for this subject — Semrush had no live data' + (keywords.length ? ': ' + keywords.slice(0, 6).join(', ') : '') + '.';
    case 'derived': return 'Keywords taken from the subject and transcript — Semrush had no live data' + (keywords.length ? ': ' + keywords.slice(0, 6).join(', ') : '') + '.';
    default: return 'Written without keyword data.';
  }
}

// web/lib/keywords.ts
// Mangools KWFinder integration used to inform AI draft generation.
//
// Every draft-generation path (Content Generator + Research Copilot) runs a
// keyword lookup for the topic BEFORE calling the model, so the AI always
// writes with real search data (volume + difficulty) in mind. The result is
// also surfaced in the UI so you can see when Mangools was used — including
// when the AI ran it automatically in the background.
//
// Auth: Mangools REST API uses an X-Access-Token header. Store the token as
// the MANGOOLS_API_TOKEN environment variable (never in client code).
// If the token is missing or the API errors, this degrades gracefully:
// callers should fall back to the KWFinder link-out and continue without data.

export type KeywordMetric = {
  keyword: string;
  volume: number | null; // avg monthly search volume
  difficulty: number | null; // 0-100 keyword difficulty
  cpc: number | null; // cost per click (USD)
};

export type KeywordResearch = {
  ok: boolean;
  source: 'mangools' | 'none';
  topic: string;
  keywords: KeywordMetric[];
  // Human-readable note for logs / UI when data is unavailable.
  note?: string;
  // Machine-readable status so the UI badge and diagnostics can distinguish
  // the *reason* data is missing instead of collapsing everything to 'none'.
  reason?: 'ok' | 'no_token' | 'auth' | 'plan' | 'http' | 'network' | 'empty';
  // Upstream HTTP status when the Mangools call was actually made (else null).
  upstreamStatus?: number | null;
};

const API_BASE = process.env.MANGOOLS_API_BASE || 'https://api.mangools.com/v3';

// Default buyer-geography location for KWFinder. Cellular Institute serves
// international patients (largely US/CA) who search *before* travelling to
// Cancun, so default to the MANGOOLS_LOCATION_ID env value when a caller does
// not pass one explicitly. Unset -> global results.
function defaultLocationId(): number | undefined {
  const raw = process.env.MANGOOLS_LOCATION_ID;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// Normalize whatever the KWFinder endpoint returns into KeywordMetric[].
// The API has evolved over versions, so we defensively read common field names.
function normalize(raw: any): KeywordMetric[] {
  const arr: any[] =
    (Array.isArray(raw) && raw) ||
    raw?.keywords ||
    raw?.data?.keywords ||
    raw?.data ||
    raw?.results ||
    [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((k: any) => ({
      keyword: String(k?.kw ?? k?.keyword ?? k?.text ?? '').trim(),
      volume: num(k?.search_volume ?? k?.volume ?? k?.sv ?? k?.avg_search_volume),
      difficulty: num(k?.difficulty ?? k?.seo_difficulty ?? k?.kd),
      cpc: num(k?.cpc),
    }))
    .filter((k: KeywordMetric) => k.keyword.length > 0);
}

// Fetch keyword ideas + metrics for a seed topic. Returns at most `limit` rows,
// sorted by search volume descending. Never throws — always resolves to a
// KeywordResearch object so draft generation is never blocked.
export async function researchKeywords(
  topic: string,
  opts: { limit?: number; locationId?: number; languageId?: number; timeoutMs?: number } = {}
): Promise<KeywordResearch> {
  const seed = (topic || '').trim();
  const base: KeywordResearch = { ok: false, source: 'none', topic: seed, keywords: [] };
  if (!seed) return { ...base, note: 'empty topic', reason: 'empty', upstreamStatus: null };

  const token = process.env.MANGOOLS_API_TOKEN;
  if (!token) {
    return { ...base, note: 'MANGOOLS_API_TOKEN not set — using KWFinder link-out only', reason: 'no_token', upstreamStatus: null };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  const url = new URL(API_BASE.replace(/\/$/, '') + '/kwfinder/related-keywords');
  url.searchParams.set('kw', seed);
  const locationId = opts.locationId ?? defaultLocationId();
  if (locationId != null) url.searchParams.set('location_id', String(locationId));
  // Mangools expects an INTEGER language_id (0 = global). Sending a string
  // like 'en' triggers an HTTP 500, so coerce and default to 0.
  const languageId = typeof opts.languageId === 'number' ? opts.languageId : 0;
  url.searchParams.set('language_id', String(languageId));

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-Access-Token': token, accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      // Distinguish *why* Mangools rejected us so the token step is debuggable.
      // 401/403 = token missing/invalid (auth); 402/429 = plan/quota limits;
      // anything else = generic upstream HTTP error. All still degrade to no data.
      let reason: KeywordResearch['reason'] = 'http';
      if (res.status === 401 || res.status === 403) reason = 'auth';
      else if (res.status === 402 || res.status === 429) reason = 'plan';
      const hint =
        reason === 'auth'
          ? 'Mangools rejected the token (invalid or plan lacks REST API access)'
          : reason === 'plan'
          ? 'Mangools plan limit or quota reached'
          : 'Mangools API error';
      return { ...base, note: hint + ' (HTTP ' + res.status + ')', reason, upstreamStatus: res.status };
    }
    const json = await res.json().catch(() => null);
    const kws = normalize(json)
      .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1))
      .slice(0, limit);
    if (!kws.length) return { ...base, source: 'mangools', note: 'no keywords returned', reason: 'ok', upstreamStatus: 200 };
    return { ok: true, source: 'mangools', topic: seed, keywords: kws, reason: 'ok', upstreamStatus: 200 };
  } catch (e: any) {
    return { ...base, note: 'Mangools API error: ' + (e?.name || 'fetch failed'), reason: 'network', upstreamStatus: null };
  } finally {
    clearTimeout(to);
  }
}

// Build a compact prompt hint the model can act on, and the list of keyword
// strings that were actually applied (for the "Keywords applied" UI badge).
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
    'SEO keyword research (Mangools KWFinder) for this topic. Naturally work the ' +
    'highest-value, lower-difficulty terms into the copy, hashtags and headings ' +
    'where they fit — do not keyword-stuff:\n' +
    lines;
  return { hint, applied };
}

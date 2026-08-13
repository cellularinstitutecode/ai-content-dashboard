// web/lib/keywords.ts
// Semrush keyword research integration used to inform AI draft generation.
//
// Every draft-generation path (Content Generator + Research Copilot) runs a
// keyword lookup for the topic BEFORE calling the model, so the AI always
// writes with real search data (volume + difficulty) in mind. The result is
// also surfaced in the UI so you can see when Semrush was used — including
// when the AI ran it automatically in the background.
//
// Auth: the Semrush Analytics API authenticates with an API key passed as the
// `key` query parameter. Store it as the SEMRUSH_API_KEY environment variable
// (never in client code). If the key is missing or the API errors, this
// degrades gracefully: callers should fall back to the Semrush link-out and
// continue without data.

export type KeywordMetric = {
  keyword: string;
  volume: number | null; // avg monthly search volume
  difficulty: number | null; // 0-100 keyword difficulty
  cpc: number | null; // cost per click (USD)
};

export type KeywordResearch = {
  ok: boolean;
  source: 'semrush' | 'none';
  topic: string;
  keywords: KeywordMetric[];
  // Human-readable note for logs / UI when data is unavailable.
  note?: string;
  // Machine-readable status so the UI badge and diagnostics can distinguish
  // the *reason* data is missing instead of collapsing everything to 'none'.
  reason?: 'ok' | 'no_token' | 'auth' | 'plan' | 'http' | 'network' | 'empty';
  // Upstream HTTP status when the Semrush call was actually made (else null).
  upstreamStatus?: number | null;
};

// Semrush Analytics API host. Override only if Semrush changes hosts.
const API_BASE = process.env.SEMRUSH_API_BASE || 'https://api.semrush.com';

// Columns requested from the phrase_related report, in a FIXED order so the
// semicolon-separated CSV can be parsed positionally:
//   Ph = Keyword, Nq = Search Volume, Cp = CPC, Co = Competition, Kd = Difficulty
const EXPORT_COLUMNS = 'Ph,Nq,Cp,Co,Kd';

// Default regional database for keyword metrics. Cellular Institute serves
// international patients (largely US/CA) who search *before* travelling to
// Cancun, so default to the SEMRUSH_DATABASE env value (e.g. 'us') when a
// caller does not pass one explicitly. Semrush encodes region + language in
// this single database code (unlike a separate location/language id).
function defaultDatabase(): string {
  return (process.env.SEMRUSH_DATABASE || 'us').trim() || 'us';
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// Parse the semicolon-separated CSV the Analytics API returns into
// KeywordMetric[]. The first line is a header row; each data row follows the
// EXPORT_COLUMNS order (Ph;Nq;Cp;Co;Kd).
function parseCsv(body: string): KeywordMetric[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return []; // header only (or empty) => no rows
  return lines
    .slice(1) // drop the header row
    .map((line) => {
      const cols = line.split(';');
      return {
        keyword: String(cols[0] ?? '').trim(),
        volume: num(cols[1]),
        cpc: num(cols[2]),
        difficulty: num(cols[4]),
      } as KeywordMetric;
    })
    .filter((k: KeywordMetric) => k.keyword.length > 0);
}

// Map a Semrush "ERROR NN :: message" code to our machine-readable reason.
// Semrush returns these as a plain-text body (typically under an HTTP 200), so
// the body — not the status code — is what tells auth vs quota vs no-data apart.
function reasonForSemrushError(code: number): NonNullable<KeywordResearch['reason']> {
  if (code === 110 || code === 120) return 'auth'; // bad / unknown API key
  if (code === 130 || code === 133 || code === 135) return 'plan'; // subscription / report / db access denied
  if (code === 131 || code === 132 || code === 134) return 'plan'; // request limit or API-unit balance exhausted
  if (code === 50) return 'empty'; // NOTHING FOUND — valid query, just no rows
  return 'http';
}

// Fetch keyword ideas + metrics for a seed topic. Returns at most `limit` rows,
// sorted by search volume descending. Never throws — always resolves to a
// KeywordResearch object so draft generation is never blocked.
export async function researchKeywords(
  topic: string,
  opts: { limit?: number; database?: string; timeoutMs?: number } = {}
): Promise<KeywordResearch> {
  const seed = (topic || '').trim();
  const base: KeywordResearch = { ok: false, source: 'none', topic: seed, keywords: [] };
  if (!seed) return { ...base, note: 'empty topic', reason: 'empty', upstreamStatus: null };

  const key = process.env.SEMRUSH_API_KEY;
  if (!key) {
    return { ...base, note: 'SEMRUSH_API_KEY not set — using Semrush link-out only', reason: 'no_token', upstreamStatus: null };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  const url = new URL(API_BASE.replace(/\/$/, '') + '/');
  url.searchParams.set('type', 'phrase_related');
  url.searchParams.set('key', key);
  url.searchParams.set('phrase', seed);
  url.searchParams.set('database', opts.database ?? defaultDatabase());
  url.searchParams.set('export_columns', EXPORT_COLUMNS);
  url.searchParams.set('display_limit', String(limit));
  url.searchParams.set('display_sort', 'nq_desc'); // highest search volume first

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/plain' },
      signal: ctl.signal,
    });
    const text = (await res.text().catch(() => '')).trim();

    // Semrush signals most logical errors with an "ERROR NN :: message" body
    // (usually under an HTTP 200). Handle that before trusting res.ok, so the
    // token/plan steps stay debuggable instead of collapsing to a blank result.
    if (/^ERROR\s+\d+/i.test(text)) {
      const code = parseInt(text.replace(/^ERROR\s+/i, ''), 10);
      const reason = reasonForSemrushError(code);
      if (reason === 'empty') {
        return { ...base, source: 'semrush', note: 'no keywords returned', reason: 'ok', upstreamStatus: res.status };
      }
      const hint =
        reason === 'auth'
          ? 'Semrush rejected the API key (invalid, or plan lacks API access)'
          : reason === 'plan'
          ? 'Semrush plan limit or API-unit balance reached'
          : 'Semrush API error';
      return { ...base, note: hint + ' (' + text.slice(0, 80) + ')', reason, upstreamStatus: res.status };
    }

    if (!res.ok) {
      // Fallback for transports that DO surface an HTTP error status.
      // 401/403 = key missing/invalid (auth); 402/429 = plan/quota; else generic.
      let reason: KeywordResearch['reason'] = 'http';
      if (res.status === 401 || res.status === 403) reason = 'auth';
      else if (res.status === 402 || res.status === 429) reason = 'plan';
      return { ...base, note: 'Semrush API error (HTTP ' + res.status + ')', reason, upstreamStatus: res.status };
    }

    const kws = parseCsv(text)
      .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1))
      .slice(0, limit);
    if (!kws.length) return { ...base, source: 'semrush', note: 'no keywords returned', reason: 'ok', upstreamStatus: res.status };
    return { ok: true, source: 'semrush', topic: seed, keywords: kws, reason: 'ok', upstreamStatus: res.status };
  } catch (e: any) {
    return { ...base, note: 'Semrush API error: ' + (e?.name || 'fetch failed'), reason: 'network', upstreamStatus: null };
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
    'SEO keyword research (Semrush) for this topic. Naturally work the ' +
    'highest-value, lower-difficulty terms into the copy, hashtags and headings ' +
    'where they fit — do not keyword-stuff:\n' +
    lines;
  return { hint, applied };
}

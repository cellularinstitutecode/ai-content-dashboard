// web/lib/semrush.ts
// The "Semrush Brain": one client for every Semrush Analytics API report the
// dashboard uses, with a Supabase-backed cache and a unit-budget guard.
//
// Design principles (unit economics):
// - The account has a FIXED pool of Standard API units (no auto top-up), so
//   every live call is treated as spending real money.
// - Every lookup is cached in Supabase (semrush_cache) for
//   SEMRUSH_CACHE_TTL_DAYS (default 30 — Semrush volumes update ~monthly).
//   Repeat topics are free.
// - Below SEMRUSH_UNIT_FLOOR remaining units (default 5000) the client stops
//   making live calls entirely and serves cache/link-out only. It never
//   silently drains the balance.
// - The balance endpoint (countapiunits.html) is FREE and powers the UI chip.
//
// Auth: `key` query parameter (SEMRUSH_API_KEY env). Errors come back as an
// "ERROR NN :: message" plain-text body, usually with HTTP 200.

import { reportError } from '@/lib/report';
import { decideSpend, applyCharge } from '@/lib/semrush-budget';
import { reasonForCode, reasonForHttpStatus, type SemrushReason } from '@/lib/semrush-reason';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SemIntent = 'commercial' | 'informational' | 'navigational' | 'transactional';

export type SemKeyword = {
  keyword: string;
  volume: number | null;
  difficulty: number | null; // 0-100 KD
  cpc: number | null;
  intents: SemIntent[]; // decoded from Semrush intent codes ("1,0" etc.)
};

export type SerpEntry = { domain: string; url: string };

export type SemSource = 'live' | 'cache' | 'none';

export type SemReportResult = {
  ok: boolean;
  rows: SemKeyword[];
  source: SemSource;
  // See lib/semrush-reason.ts for what each state means and which ones are
  // "serve the cache" rather than "a human should chase this".
  reason: SemrushReason;
  note?: string;
  unitsSpent: number;
};

export type KeywordBrief = {
  topic: string;
  primary: SemKeyword | null;
  supporting: SemKeyword[]; // up to 6
  questions: SemKeyword[]; // up to 3 question-phrased searches
  intentSummary: string;
  source: 'semrush' | 'none';
  fromCache: boolean;
  unitsSpent: number;
};

export type ResearchBundle = {
  brief: KeywordBrief;
  related: SemKeyword[]; // full related table for the UI
  questions: SemKeyword[]; // full questions list for the UI
  reason: SemReportResult['reason'];
  note?: string;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = process.env.SEMRUSH_API_BASE || 'https://api.semrush.com';
// Balance endpoint lives on www.semrush.com and costs 0 units.
const BALANCE_URL = 'https://www.semrush.com/users/countapiunits.html';

// Standard API price list (units per RESULT LINE) for the reports we use.
export const UNIT_COST: Record<string, number> = {
  phrase_this: 10,
  phrase_these: 10,
  phrase_related: 40,
  phrase_questions: 40,
  phrase_organic: 10,
  // Domain intelligence reports (see lib/semrush-domain.ts)
  domain_ranks: 10,
  domain_organic: 10,
  domain_organic_organic: 40,
  backlinks_overview: 40, // per request (1 line)
  backlinks_refdomains: 40,
  // Projects API endpoints bill per REQUEST, not per line.
  siteaudit_info: 100,
  tracking_report: 100,
};

export function db(): string {
  return (process.env.SEMRUSH_DATABASE || 'us').trim() || 'us';
}
function unitFloor(): number {
  const n = parseInt(process.env.SEMRUSH_UNIT_FLOOR || '5000', 10);
  return Number.isFinite(n) ? n : 5000;
}
function cacheTtlMs(): number {
  const d = parseInt(process.env.SEMRUSH_CACHE_TTL_DAYS || '30', 10);
  return (Number.isFinite(d) ? d : 30) * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

const INTENT_NAMES: Record<string, SemIntent> = {
  '0': 'commercial',
  '1': 'informational',
  '2': 'navigational',
  '3': 'transactional',
};

export function decodeIntents(raw: string | null | undefined): SemIntent[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((c) => INTENT_NAMES[c.trim()])
    .filter(Boolean) as SemIntent[];
}

// Parse the semicolon-CSV for keyword reports requested with columns
// Ph,Nq,Cp,Kd,In → "Keyword;Search Volume;CPC;Keyword Difficulty Index;Intent".
export function parseKeywordCsv(body: string): SemKeyword[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  return lines
    .slice(1)
    .map((line) => {
      const c = line.split(';');
      return {
        keyword: String(c[0] ?? '').trim(),
        volume: num(c[1]),
        cpc: num(c[2]),
        difficulty: num(c[3]),
        intents: decodeIntents(c[4]),
      } as SemKeyword;
    })
    .filter((k) => k.keyword.length > 0);
}

// Parse phrase_organic requested with columns Dn,Ur → "Domain;Url".
export function parseSerpCsv(body: string): SerpEntry[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  return lines
    .slice(1)
    .map((line) => {
      const c = line.split(';');
      return { domain: String(c[0] ?? '').trim(), url: String(c[1] ?? '').trim() };
    })
    .filter((r) => r.domain.length > 0);
}

// ---------------------------------------------------------------------------
// Unit balance + budget guard (balance endpoint is free)
// ---------------------------------------------------------------------------

let balanceCache: { value: number | null; at: number } = { value: null, at: 0 };
const BALANCE_TTL_MS = 10 * 60 * 1000;
// A balance we could NOT read is cached far more briefly than a good one. It
// used to share the 10-minute TTL, which meant one bad response disabled the
// spend floor for ten minutes (see budgetAllows).
const BALANCE_ERROR_TTL_MS = 30 * 1000;

export async function getUnitsBalance(force = false): Promise<number | null> {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) return null;
  const now = Date.now();
  const ttl = balanceCache.value == null ? BALANCE_ERROR_TTL_MS : BALANCE_TTL_MS;
  if (!force && balanceCache.at && now - balanceCache.at < ttl) return balanceCache.value;
  try {
    const res = await fetch(BALANCE_URL + '?key=' + encodeURIComponent(key), { method: 'GET' });
    const text = (await res.text()).trim();
    const n = parseInt(text, 10);
    if (!Number.isFinite(n)) {
      // Semrush answered with something that is not a number - an HTML error,
      // a maintenance page, a login redirect. Say so: this switches the spend
      // floor to fail-closed until we can read a real number again, and that
      // is worth knowing about rather than discovering on an invoice.
      reportError('semrush:balance-unreadable', new Error('non-numeric balance response'), {
        status: res.status,
        sample: text.slice(0, 120),
      });
    }
    balanceCache = { value: Number.isFinite(n) ? n : null, at: now };
    return balanceCache.value;
  } catch (err) {
    reportError('semrush:balance-fetch-failed', err);
    return balanceCache.value; // stale-if-error
  }
}

/**
 * Charge the cached balance for units we just spent.
 *
 * Without this the cached number stayed at its pre-spend value for the whole
 * TTL, so concurrent callers each measured the same headroom: `domainBundle`
 * fires four reports in a Promise.all and all four saw the balance as it was
 * before any of them ran. The floor could be overshot by the size of a burst.
 * This is a local estimate, not a source of truth - the next live read
 * replaces it - but it makes the guard directional between reads.
 */
export function chargeUnits(units: number): void {
  balanceCache = { value: applyCharge(balanceCache.value, units), at: balanceCache.at };
}

/**
 * May we spend an estimated number of units on a live call right now?
 *
 * FAILS CLOSED when the balance cannot be read. It used to return true, on the
 * reasoning that the API could decide for itself - but the API's decision is to
 * spend the units. A guard whose entire job is "never silently drain the unit
 * pot" must not open itself the moment it loses sight of the pot; every other
 * guard in this codebase (the rate limiter especially) fails closed for the
 * same reason. Cached lookups and the link-out path still work while it is shut,
 * and the error TTL above means it reopens within 30s of the balance endpoint
 * recovering.
 */
export async function budgetAllows(estUnits: number): Promise<boolean> {
  const hasKey = Boolean(process.env.SEMRUSH_API_KEY);
  const bal = hasKey ? await getUnitsBalance() : null;
  const decision = decideSpend(bal, estUnits, unitFloor(), hasKey);
  if (!decision.allow && decision.reason === 'balance-unknown') {
    reportError('semrush:budget-closed', new Error('spend refused: balance unreadable'), {
      estUnits,
      floor: unitFloor(),
    });
  }
  return decision.allow;
}

export type KeywordCapability = {
  /** Would a keyword lookup for a draft run live right now? */
  ok: boolean;
  reason: 'ok' | 'no_token' | 'budget' | 'balance-unknown';
  balance: number | null;
  floor: number;
};

/**
 * Whether keyword research is actually WORKING — not whether it is configured.
 *
 * /api/health asked `has('SEMRUSH_API_KEY')`, which on the live deployment was
 * true while every lookup was being refused by the unit floor. So the status
 * banner built to announce exactly that condition stayed silent, and the
 * dashboard showed a blank Site Audit dial, an empty rank chart and a
 * "written without live keyword data" note with no stated cause. This answers
 * the question the banner needs answered, with the same guard the real calls
 * go through, priced at the first report a draft would spend on.
 *
 * Cost: one read of the FREE balance endpoint, cached for ten minutes and
 * served stale on error — so it cannot itself fail because Semrush is down;
 * it just fails closed, which is the truthful answer in that case too.
 */
export async function keywordCapability(): Promise<KeywordCapability> {
  const hasKey = Boolean(process.env.SEMRUSH_API_KEY);
  const floor = unitFloor();
  if (!hasKey) return { ok: false, reason: 'no_token', balance: null, floor };
  const balance = await getUnitsBalance();
  const decision = decideSpend(balance, UNIT_COST.phrase_related, floor, hasKey);
  if (decision.allow) return { ok: true, reason: 'ok', balance, floor };
  return {
    ok: false,
    reason: decision.reason === 'balance-unknown' ? 'balance-unknown' : 'budget',
    balance,
    floor,
  };
}

// ---------------------------------------------------------------------------
// Supabase cache + usage log (both fail-open: DB trouble never blocks research)
// ---------------------------------------------------------------------------

type CacheHit = { rows: any[]; fetched_at: string };

function cacheKey(report: string, database: string, phrase: string): string {
  return report + ':' + database + ':' + phrase.toLowerCase().trim();
}

export async function cacheGet(report: string, database: string, phrase: string, ttlMs?: number): Promise<any[] | null> {
  try {
    const { data } = await supabaseAdmin()
      .from('semrush_cache')
      .select('payload, fetched_at')
      .eq('cache_key', cacheKey(report, database, phrase))
      .maybeSingle();
    if (!data) return null;
    const hit = data as unknown as { payload: any; fetched_at: string };
    if (Date.now() - new Date(hit.fetched_at).getTime() > (ttlMs ?? cacheTtlMs())) return null;
    return Array.isArray(hit.payload) ? hit.payload : null;
  } catch {
    return null;
  }
}

export async function cachePut(report: string, database: string, phrase: string, rows: any[], units: number): Promise<void> {
  try {
    await supabaseAdmin()
      .from('semrush_cache')
      .upsert(
        {
          cache_key: cacheKey(report, database, phrase),
          report,
          database,
          phrase: phrase.toLowerCase().trim(),
          payload: rows,
          units_spent: units,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'cache_key' }
      );
  } catch {
    // ignore
  }
}

export async function logUsage(report: string, phrase: string, units: number, source: SemSource): Promise<void> {
  // Every live spend flows through here, so this is the one place that can keep
  // the cached balance moving in the right direction between reads.
  if (source === 'live') chargeUnits(units);
  try {
    await supabaseAdmin().from('semrush_usage').insert({ report, phrase, units, source });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Low-level report fetcher (cache-first, budget-guarded)
// ---------------------------------------------------------------------------

async function runReport(
  report: 'phrase_this' | 'phrase_related' | 'phrase_questions' | 'phrase_organic' | 'phrase_these',
  phrase: string,
  opts: { limit?: number; database?: string; extraParams?: Record<string, string>; exportColumns: string; timeoutMs?: number }
): Promise<{ ok: boolean; body?: string; rowsCached?: any[]; source: SemSource; reason: SemReportResult['reason']; note?: string; unitsSpent: number }> {
  const database = opts.database ?? db();
  const seed = (phrase || '').trim();
  if (!seed) return { ok: false, source: 'none', reason: 'empty', note: 'empty phrase', unitsSpent: 0 };

  // 1) cache
  const cached = await cacheGet(report, database, seed);
  if (cached) {
    void logUsage(report, seed, 0, 'cache');
    return { ok: true, rowsCached: cached, source: 'cache', reason: 'ok', unitsSpent: 0 };
  }

  // 2) live — only with a key and inside budget
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) return { ok: false, source: 'none', reason: 'no_token', note: 'SEMRUSH_API_KEY not set — cache/link-out only', unitsSpent: 0 };

  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  const estUnits = (UNIT_COST[report] ?? 40) * limit;
  if (!(await budgetAllows(estUnits))) {
    return { ok: false, source: 'none', reason: 'budget', note: 'Unit balance at protection floor — serving cache/link-out only', unitsSpent: 0 };
  }

  const url = new URL(API_BASE.replace(/\/$/, '') + '/');
  url.searchParams.set('type', report);
  url.searchParams.set('key', key);
  url.searchParams.set('phrase', seed);
  url.searchParams.set('database', database);
  url.searchParams.set('export_columns', opts.exportColumns);
  url.searchParams.set('display_limit', String(limit));
  for (const [k, v] of Object.entries(opts.extraParams || {})) url.searchParams.set(k, v);

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers: { accept: 'text/plain' }, signal: ctl.signal });
    const text = (await res.text().catch(() => '')).trim();
    if (/^ERROR\s+\d+/i.test(text)) {
      const code = parseInt(text.replace(/^ERROR\s+/i, ''), 10);
      const reason = reasonForCode(code);
      if (reason === 'empty') return { ok: true, body: '', source: 'live', reason: 'ok', unitsSpent: 0 };
      return { ok: false, source: 'none', reason, note: text.slice(0, 100), unitsSpent: 0 };
    }
    if (!res.ok) {
      const reason = reasonForHttpStatus(res.status);
      return { ok: false, source: 'none', reason, note: 'HTTP ' + res.status, unitsSpent: 0 };
    }
    return { ok: true, body: text, source: 'live', reason: 'ok', unitsSpent: estUnits };
  } catch (e: any) {
    return { ok: false, source: 'none', reason: 'network', note: e?.name || 'fetch failed', unitsSpent: 0 };
  } finally {
    clearTimeout(to);
  }
}

// ---------------------------------------------------------------------------
// Public report calls
// ---------------------------------------------------------------------------

const KW_COLUMNS = 'Ph,Nq,Cp,Kd,In';

async function keywordReport(
  report: 'phrase_related' | 'phrase_questions',
  topic: string,
  opts: { limit?: number; database?: string } = {}
): Promise<SemReportResult> {
  const r = await runReport(report, topic, {
    limit: opts.limit,
    database: opts.database,
    exportColumns: KW_COLUMNS,
    extraParams: { display_sort: 'nq_desc' },
  });
  if (r.rowsCached) return { ok: true, rows: r.rowsCached as SemKeyword[], source: 'cache', reason: 'ok', unitsSpent: 0 };
  if (!r.ok) return { ok: false, rows: [], source: r.source, reason: r.reason, note: r.note, unitsSpent: 0 };
  const rows = parseKeywordCsv(r.body || '');
  const units = rows.length * (UNIT_COST[report] ?? 40); // actual lines returned
  if (rows.length) {
    void cachePut(report, opts.database ?? db(), topic, rows, units);
    void logUsage(report, topic, units, 'live');
  }
  return { ok: true, rows, source: 'live', reason: 'ok', unitsSpent: units };
}

export function relatedKeywords(topic: string, opts: { limit?: number; database?: string } = {}): Promise<SemReportResult> {
  return keywordReport('phrase_related', topic, opts);
}

export function questionKeywords(topic: string, opts: { limit?: number; database?: string } = {}): Promise<SemReportResult> {
  return keywordReport('phrase_questions', topic, opts);
}

export async function serpCompetitors(
  topic: string,
  opts: { limit?: number; database?: string } = {}
): Promise<{ ok: boolean; rows: SerpEntry[]; source: SemSource; reason: SemReportResult['reason']; note?: string; unitsSpent: number }> {
  const r = await runReport('phrase_organic', topic, {
    limit: opts.limit ?? 10,
    database: opts.database,
    exportColumns: 'Dn,Ur',
  });
  if (r.rowsCached) return { ok: true, rows: r.rowsCached as SerpEntry[], source: 'cache', reason: 'ok', unitsSpent: 0 };
  if (!r.ok) return { ok: false, rows: [], source: r.source, reason: r.reason, note: r.note, unitsSpent: 0 };
  const rows = parseSerpCsv(r.body || '');
  const units = rows.length * UNIT_COST.phrase_organic;
  if (rows.length) {
    void cachePut('phrase_organic', opts.database ?? db(), topic, rows, units);
    void logUsage('phrase_organic', topic, units, 'live');
  }
  return { ok: true, rows, source: 'live', reason: 'ok', unitsSpent: units };
}

// ---------------------------------------------------------------------------
// The brain: KeywordBrief — the mandatory pre-filter for every draft
// ---------------------------------------------------------------------------

// Opportunity score: reward demand, punish difficulty. Tuned for a clinic site
// (moderate authority): keywords above KD 70 rarely worth chasing head-on.
export function opportunityScore(k: SemKeyword): number {
  const v = k.volume ?? 0;
  const kd = k.difficulty ?? 50;
  return Math.round(Math.pow(v, 0.7) * ((100 - Math.min(kd, 95)) / 100));
}

export function selectBrief(topic: string, related: SemKeyword[], questions: SemKeyword[]): Omit<KeywordBrief, 'source' | 'fromCache' | 'unitsSpent'> {
  const scored = related
    .filter((k) => (k.volume ?? 0) > 0)
    .map((k) => ({ k, s: opportunityScore(k) }))
    .sort((a, b) => b.s - a.s);
  // Primary: best opportunity with KD <= 60 if one exists, else best overall.
  const easyFirst = scored.filter((x) => (x.k.difficulty ?? 100) <= 60);
  const primary = (easyFirst[0] || scored[0])?.k ?? null;
  const supporting = scored
    .map((x) => x.k)
    .filter((k) => k !== primary)
    .slice(0, 6);
  const qs = questions
    .slice()
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 3);
  const intentCounts = new Map<string, number>();
  for (const k of [primary, ...supporting].filter(Boolean) as SemKeyword[]) {
    for (const i of k.intents) intentCounts.set(i, (intentCounts.get(i) || 0) + 1);
  }
  const intentSummary =
    Array.from(intentCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([i]) => i)
      .slice(0, 2)
      .join(' + ') || 'informational';
  return { topic, primary, supporting, questions: qs, intentSummary };
}

// Fetch related + questions (cache-first) and assemble the brief + UI tables.
export async function researchBundle(topic: string, opts: { database?: string; relatedLimit?: number; questionLimit?: number } = {}): Promise<ResearchBundle> {
  const rel = await relatedKeywords(topic, { limit: opts.relatedLimit ?? 12, database: opts.database });
  // Questions are optional garnish: skip silently when unavailable.
  const qs = rel.ok && rel.rows.length ? await questionKeywords(topic, { limit: opts.questionLimit ?? 6, database: opts.database }) : { ok: false, rows: [], source: 'none' as SemSource, reason: rel.reason, unitsSpent: 0 };
  const haveData = rel.ok && rel.rows.length > 0;
  const sel = selectBrief(topic, rel.rows, qs.rows);
  const brief: KeywordBrief = {
    ...sel,
    source: haveData ? 'semrush' : 'none',
    fromCache: rel.source === 'cache',
    unitsSpent: (rel.unitsSpent || 0) + (qs.unitsSpent || 0),
  };
  return { brief, related: rel.rows, questions: qs.rows, reason: rel.reason, note: rel.note };
}

export async function buildKeywordBrief(topic: string, opts: { database?: string } = {}): Promise<KeywordBrief> {
  return (await researchBundle(topic, opts)).brief;
}

// The prompt contract injected before every draft. Firm, but anti-stuffing.
export function briefPromptFrom(brief: KeywordBrief): string {
  if (brief.source !== 'semrush' || !brief.primary) return '';
  const fmt = (k: SemKeyword) =>
    k.keyword + ' (' + (k.volume != null ? k.volume + '/mo' : 'n/a') + ', KD ' + (k.difficulty != null ? k.difficulty : '?') + ')';
  const lines: string[] = [];
  lines.push('SEMRUSH KEYWORD BRIEF (real search data — follow this contract):');
  lines.push('- PRIMARY keyword: ' + fmt(brief.primary) + '. Use it in the headline/hook and naturally 1-2 more times.');
  if (brief.supporting.length) {
    lines.push('- SUPPORTING terms (work each in once where natural): ' + brief.supporting.map(fmt).join('; '));
  }
  if (brief.questions.length) {
    lines.push('- Answer at least one of these real searcher questions in the body: ' + brief.questions.map((q) => '"' + q.keyword + '"').join(', '));
  }
  lines.push('- Searcher intent is mostly ' + brief.intentSummary + ' — match the angle to it.');
  lines.push('- Never keyword-stuff; keep medical claims compliant and non-exaggerated.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Learnings: record which keywords each draft used (joined later with
// post_metrics to surface what actually performs).
// ---------------------------------------------------------------------------

export async function recordDraftKeywords(userId: string, topic: string, brief: KeywordBrief): Promise<void> {
  if (brief.source !== 'semrush') return;
  const rows = [brief.primary, ...brief.supporting]
    .filter(Boolean)
    .map((k) => ({
      user_id: userId,
      topic,
      keyword: (k as SemKeyword).keyword,
      volume: (k as SemKeyword).volume,
      difficulty: (k as SemKeyword).difficulty,
      intent: (k as SemKeyword).intents.join(','),
      role: k === brief.primary ? 'primary' : 'supporting',
    }));
  if (!rows.length) return;
  try {
    await supabaseAdmin().from('draft_keywords').insert(rows);
  } catch {
    // ignore — learnings are best-effort
  }
}

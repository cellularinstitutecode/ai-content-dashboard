// web/lib/semrush-domain.ts
// Semrush Domain Intelligence: everything the SEO panel shows about the
// clinic's own domain (and any competitor domain typed into the panel).
//
// Built on the same principles as lib/semrush.ts (the keyword "brain"):
// - cache-first via the shared Supabase semrush_cache table,
// - budget-guarded (never drains the fixed unit pool),
// - degrades gracefully to link-out when the key/plan is missing.
//
// Reports used (Standard Analytics API, semicolon-CSV responses):
//   domain_ranks            10 u/line  — rank, organic/paid keywords+traffic
//   domain_organic          10 u/line  — top ranking keywords w/ positions
//   domain_organic_organic  40 u/line  — organic competitors
//   backlinks_overview      40 u/req   — authority score, backlinks, ref domains
// Projects API (JSON, 100 u/request, needs SEMRUSH_PROJECT_ID):
//   /reports/v1/projects/{id}/siteaudit/info      — site health, errors, warnings
//   /reports/v1/projects/{id}/tracking/ (reports) — position-tracking visibility
//
// Domain metrics move slowly, so domain reports default to a 24h cache TTL
// (SEMRUSH_DOMAIN_CACHE_TTL_HOURS) instead of the 30-day keyword TTL.

import {
  UNIT_COST,
  budgetAllows,
  cacheGet,
  cachePut,
  db,
  decodeIntents,
  getUnitsBalance,
  logUsage,
  type SemReportResult,
  type SemSource,
} from '@/lib/semrush';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SectionMeta = {
  ok: boolean;
  source: SemSource;
  reason: SemReportResult['reason'];
  note?: string;
  unitsSpent: number;
};

export type DomainOverview = {
  domain: string;
  rank: number | null; // Semrush Rank
  organicKeywords: number | null;
  organicTraffic: number | null;
  organicCost: number | null;
  paidKeywords: number | null;
  paidTraffic: number | null;
  paidCost: number | null;
};

export type BacklinksOverview = {
  authorityScore: number | null;
  backlinksTotal: number | null;
  refDomains: number | null;
  refUrls: number | null;
  refIps: number | null;
  follows: number | null;
  nofollows: number | null;
  texts: number | null;
  images: number | null;
};

export type OrganicKeywordRow = {
  keyword: string;
  position: number | null;
  prevPosition: number | null;
  positionDiff: number | null;
  volume: number | null;
  cpc: number | null;
  url: string;
  trafficPct: number | null;
  difficulty: number | null;
  intents: string[];
};

export type CompetitorRow = {
  domain: string;
  competitionLevel: number | null; // 0..1
  commonKeywords: number | null;
  organicKeywords: number | null;
  organicTraffic: number | null;
  organicCost: number | null;
};

export type SiteAuditSnapshot = {
  configured: boolean;
  status: string | null;
  health: number | null; // 0..100 (quality.value)
  healthDelta: number | null;
  errors: number | null;
  warnings: number | null;
  notices: number | null;
  pagesCrawled: number | null;
  pagesHealthy: number | null;
  pagesWithIssues: number | null;
  lastAudit: string | null; // ISO date
};

export type TrackingPoint = { date: string; visibility: number | null };

export type TrackingSummary = {
  configured: boolean;
  visibility: number | null; // latest visibility %
  visibilityDelta: number | null; // vs first point in window
  avgPosition: number | null;
  trend: TrackingPoint[];
};

export type DomainBundle = {
  domain: string;
  isPrimaryDomain: boolean;
  overview: DomainOverview | null;
  overviewMeta: SectionMeta;
  backlinks: BacklinksOverview | null;
  backlinksMeta: SectionMeta;
  topKeywords: OrganicKeywordRow[];
  topKeywordsMeta: SectionMeta;
  competitors: CompetitorRow[];
  competitorsMeta: SectionMeta;
  balance: number | null;
  unitsSpent: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = process.env.SEMRUSH_API_BASE || 'https://api.semrush.com';

export function primaryDomain(): string {
  return (process.env.SEMRUSH_DOMAIN || 'cellularhopeinstitute.com')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

export function projectId(): string {
  return (process.env.SEMRUSH_PROJECT_ID || '').trim();
}

function domainCacheTtlMs(): number {
  const h = parseInt(process.env.SEMRUSH_DOMAIN_CACHE_TTL_HOURS || '24', 10);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
}

export function normalizeDomain(raw: string): string {
  return (raw || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Low-level fetch (CSV endpoints). Mirrors lib/semrush.ts runReport but with
// arbitrary query params (domain reports use `domain=`/`target=`, not `phrase=`).
// ---------------------------------------------------------------------------

type RawResult = {
  ok: boolean;
  body?: string;
  rowsCached?: any[];
  source: SemSource;
  reason: SemReportResult['reason'];
  note?: string;
  unitsSpent: number;
};

function reasonForCode(code: number): SemReportResult['reason'] {
  if (code === 110 || code === 120) return 'auth';
  if (code >= 130 && code <= 135) return 'plan';
  if (code === 50) return 'empty';
  return 'http';
}

async function rawCsvReport(
  report: string,
  cachePhrase: string,
  params: Record<string, string>,
  opts: { estLines: number; path?: string; timeoutMs?: number; ttlMs?: number }
): Promise<RawResult> {
  const database = db();

  // 1) cache
  const cached = await cacheGet(report, database, cachePhrase, opts.ttlMs ?? domainCacheTtlMs());
  if (cached) {
    void logUsage(report, cachePhrase, 0, 'cache');
    return { ok: true, rowsCached: cached, source: 'cache', reason: 'ok', unitsSpent: 0 };
  }

  // 2) live — only with a key and inside budget
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) return { ok: false, source: 'none', reason: 'no_token', note: 'SEMRUSH_API_KEY not set', unitsSpent: 0 };

  const estUnits = (UNIT_COST[report] ?? 40) * Math.max(1, opts.estLines);
  if (!(await budgetAllows(estUnits))) {
    return { ok: false, source: 'none', reason: 'budget', note: 'Unit balance at protection floor', unitsSpent: 0 };
  }

  const url = new URL(API_BASE.replace(/\/$/, '') + (opts.path ?? '/'));
  url.searchParams.set('type', report);
  url.searchParams.set('key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers: { accept: 'text/plain' }, signal: ctl.signal });
    const text = (await res.text().catch(() => '')).trim();
    if (/^ERROR\s+\d+/i.test(text)) {
      const code = parseInt(text.replace(/^ERROR\s+/i, ''), 10);
      const reason = reasonForCode(code);
      if (reason === 'empty') return { ok: true, body: '', source: 'live', reason: 'ok', unitsSpent: 0 };
      return { ok: false, source: 'none', reason, note: text.slice(0, 120), unitsSpent: 0 };
    }
    if (!res.ok) {
      let reason: SemReportResult['reason'] = 'http';
      if (res.status === 401 || res.status === 403) reason = 'auth';
      else if (res.status === 402 || res.status === 429) reason = 'plan';
      return { ok: false, source: 'none', reason, note: 'HTTP ' + res.status, unitsSpent: 0 };
    }
    return { ok: true, body: text, source: 'live', reason: 'ok', unitsSpent: estUnits };
  } catch (e: any) {
    return { ok: false, source: 'none', reason: 'network', note: e?.name || 'fetch failed', unitsSpent: 0 };
  } finally {
    clearTimeout(to);
  }
}

// Generic semicolon-CSV → array of objects keyed by header cell.
export function parseCsvRows(body: string): Record<string, string>[] {
  const lines = (body || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(';');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

function meta(r: RawResult, unitsSpent: number): SectionMeta {
  return { ok: r.ok, source: r.source, reason: r.reason, note: r.note, unitsSpent };
}

// ---------------------------------------------------------------------------
// Domain overview (domain_ranks)
// ---------------------------------------------------------------------------

export async function domainOverview(domain: string): Promise<{ data: DomainOverview | null; meta: SectionMeta }> {
  const r = await rawCsvReport(
    'domain_ranks',
    domain,
    { domain, database: db(), export_columns: 'Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac' },
    { estLines: 1 }
  );
  const finish = (rows: Record<string, string>[], units: number, src: RawResult): { data: DomainOverview | null; meta: SectionMeta } => {
    const row = rows[0];
    if (!row) return { data: null, meta: { ...meta(src, units), ok: false, reason: src.reason === 'ok' ? 'empty' : src.reason } };
    return {
      data: {
        domain,
        rank: num(row['Rank']),
        organicKeywords: num(row['Organic Keywords']),
        organicTraffic: num(row['Organic Traffic']),
        organicCost: num(row['Organic Cost']),
        paidKeywords: num(row['Adwords Keywords']),
        paidTraffic: num(row['Adwords Traffic']),
        paidCost: num(row['Adwords Cost']),
      },
      meta: meta(src, units),
    };
  };
  if (r.rowsCached) return finish(r.rowsCached as Record<string, string>[], 0, r);
  if (!r.ok) return { data: null, meta: meta(r, 0) };
  const rows = parseCsvRows(r.body || '');
  const units = rows.length * UNIT_COST.domain_ranks;
  if (rows.length) {
    void cachePut('domain_ranks', db(), domain, rows, units);
    void logUsage('domain_ranks', domain, units, 'live');
  }
  return finish(rows, units, r);
}

// ---------------------------------------------------------------------------
// Backlinks overview (authority score, backlinks, ref domains)
// ---------------------------------------------------------------------------

export async function backlinksOverview(domain: string): Promise<{ data: BacklinksOverview | null; meta: SectionMeta }> {
  const r = await rawCsvReport(
    'backlinks_overview',
    domain,
    {
      target: domain,
      target_type: 'root_domain',
      export_columns: 'ascore,total,domains_num,urls_num,ips_num,follows_num,nofollows_num,texts_num,images_num',
    },
    { estLines: 1, path: '/analytics/v1/' }
  );
  const finish = (rows: Record<string, string>[], units: number, src: RawResult): { data: BacklinksOverview | null; meta: SectionMeta } => {
    const row = rows[0];
    if (!row) return { data: null, meta: { ...meta(src, units), ok: false, reason: src.reason === 'ok' ? 'empty' : src.reason } };
    return {
      data: {
        authorityScore: num(row['ascore']),
        backlinksTotal: num(row['total']),
        refDomains: num(row['domains_num']),
        refUrls: num(row['urls_num']),
        refIps: num(row['ips_num']),
        follows: num(row['follows_num']),
        nofollows: num(row['nofollows_num']),
        texts: num(row['texts_num']),
        images: num(row['images_num']),
      },
      meta: meta(src, units),
    };
  };
  if (r.rowsCached) return finish(r.rowsCached as Record<string, string>[], 0, r);
  if (!r.ok) return { data: null, meta: meta(r, 0) };
  const rows = parseCsvRows(r.body || '');
  const units = UNIT_COST.backlinks_overview; // billed per request
  if (rows.length) {
    void cachePut('backlinks_overview', db(), domain, rows, units);
    void logUsage('backlinks_overview', domain, units, 'live');
  }
  return finish(rows, rows.length ? units : 0, r);
}

// ---------------------------------------------------------------------------
// Top organic keywords with positions (domain_organic)
// ---------------------------------------------------------------------------

export async function topOrganicKeywords(
  domain: string,
  limit = 15
): Promise<{ rows: OrganicKeywordRow[]; meta: SectionMeta }> {
  const lim = Math.max(1, Math.min(limit, 30));
  const r = await rawCsvReport(
    'domain_organic',
    domain + ':top:' + lim,
    {
      domain,
      database: db(),
      display_limit: String(lim),
      display_sort: 'tr_desc',
      export_columns: 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Kd,In',
    },
    { estLines: lim }
  );
  const toRows = (rows: Record<string, string>[]): OrganicKeywordRow[] =>
    rows
      .map((row) => {
        const pos = num(row['Position']);
        const prev = num(row['Previous Position']);
        return {
          keyword: row['Keyword'] || '',
          position: pos,
          prevPosition: prev,
          positionDiff: num(row['Position Difference']),
          volume: num(row['Search Volume']),
          cpc: num(row['CPC']),
          url: row['Url'] || '',
          trafficPct: num(row['Traffic (%)'] ?? row['Traffic']),
          difficulty: num(row['Keyword Difficulty Index'] ?? row['Keyword Difficulty']),
          intents: decodeIntents(row['Intents'] ?? row['Intent']),
        } as OrganicKeywordRow;
      })
      .filter((k) => k.keyword.length > 0);
  if (r.rowsCached) return { rows: toRows(r.rowsCached as Record<string, string>[]), meta: meta(r, 0) };
  if (!r.ok) return { rows: [], meta: meta(r, 0) };
  const parsed = parseCsvRows(r.body || '');
  const units = parsed.length * UNIT_COST.domain_organic;
  if (parsed.length) {
    void cachePut('domain_organic', db(), domain + ':top:' + lim, parsed, units);
    void logUsage('domain_organic', domain, units, 'live');
  }
  return { rows: toRows(parsed), meta: meta(r, units) };
}

// ---------------------------------------------------------------------------
// Organic competitors (domain_organic_organic)
// ---------------------------------------------------------------------------

export async function organicCompetitors(
  domain: string,
  limit = 5
): Promise<{ rows: CompetitorRow[]; meta: SectionMeta }> {
  const lim = Math.max(1, Math.min(limit, 10));
  const r = await rawCsvReport(
    'domain_organic_organic',
    domain + ':comp:' + lim,
    {
      domain,
      database: db(),
      display_limit: String(lim),
      display_sort: 'np_desc',
      export_columns: 'Dn,Cr,Np,Or,Ot,Oc',
    },
    { estLines: lim }
  );
  const toRows = (rows: Record<string, string>[]): CompetitorRow[] =>
    rows
      .map((row) => ({
        domain: row['Domain'] || '',
        competitionLevel: num(row['Competitor Relevance'] ?? row['Competition Level']),
        commonKeywords: num(row['Common Keywords']),
        organicKeywords: num(row['Organic Keywords']),
        organicTraffic: num(row['Organic Traffic']),
        organicCost: num(row['Organic Cost']),
      }))
      .filter((c) => c.domain.length > 0);
  if (r.rowsCached) return { rows: toRows(r.rowsCached as Record<string, string>[]), meta: meta(r, 0) };
  if (!r.ok) return { rows: [], meta: meta(r, 0) };
  const parsed = parseCsvRows(r.body || '');
  const units = parsed.length * UNIT_COST.domain_organic_organic;
  if (parsed.length) {
    void cachePut('domain_organic_organic', db(), domain + ':comp:' + lim, parsed, units);
    void logUsage('domain_organic_organic', domain, units, 'live');
  }
  return { rows: toRows(parsed), meta: meta(r, units) };
}

// ---------------------------------------------------------------------------
// Projects API (JSON): Site Audit + Position Tracking. Requires
// SEMRUSH_PROJECT_ID. Billed 100 units/request → cached 12h by default.
// ---------------------------------------------------------------------------

const PROJECT_TTL_MS = 12 * 60 * 60 * 1000;

async function projectJson(
  cacheReport: string,
  cachePhrase: string,
  path: string,
  params: Record<string, string>
): Promise<{ json: any | null; meta: SectionMeta }> {
  const cached = await cacheGet(cacheReport, 'proj', cachePhrase, PROJECT_TTL_MS);
  if (cached && cached[0]) {
    void logUsage(cacheReport, cachePhrase, 0, 'cache');
    return { json: cached[0], meta: { ok: true, source: 'cache', reason: 'ok', unitsSpent: 0 } };
  }
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) return { json: null, meta: { ok: false, source: 'none', reason: 'no_token', unitsSpent: 0 } };
  const est = UNIT_COST.siteaudit_info;
  if (!(await budgetAllows(est))) {
    return { json: null, meta: { ok: false, source: 'none', reason: 'budget', note: 'Unit balance at protection floor', unitsSpent: 0 } };
  }
  const url = new URL(API_BASE.replace(/\/$/, '') + path);
  url.searchParams.set('key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers: { accept: 'application/json' }, signal: ctl.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let reason: SemReportResult['reason'] = 'http';
      if (res.status === 401 || res.status === 403) reason = 'auth';
      else if (res.status === 402 || res.status === 429 || res.status === 404) reason = 'plan';
      return { json: null, meta: { ok: false, source: 'none', reason, note: 'HTTP ' + res.status, unitsSpent: 0 } };
    }
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json == null) return { json: null, meta: { ok: false, source: 'none', reason: 'http', note: 'unexpected response', unitsSpent: 0 } };
    void cachePut(cacheReport, 'proj', cachePhrase, [json], est);
    void logUsage(cacheReport, cachePhrase, est, 'live');
    return { json, meta: { ok: true, source: 'live', reason: 'ok', unitsSpent: est } };
  } catch (e: any) {
    return { json: null, meta: { ok: false, source: 'none', reason: 'network', note: e?.name || 'fetch failed', unitsSpent: 0 } };
  } finally {
    clearTimeout(to);
  }
}

export async function siteAudit(): Promise<{ data: SiteAuditSnapshot; meta: SectionMeta }> {
  const id = projectId();
  const empty: SiteAuditSnapshot = {
    configured: Boolean(id), status: null, health: null, healthDelta: null,
    errors: null, warnings: null, notices: null,
    pagesCrawled: null, pagesHealthy: null, pagesWithIssues: null, lastAudit: null,
  };
  if (!id) return { data: empty, meta: { ok: false, source: 'none', reason: 'no_token', note: 'SEMRUSH_PROJECT_ID not set', unitsSpent: 0 } };
  const { json, meta: m } = await projectJson('siteaudit_info', id, `/reports/v1/projects/${encodeURIComponent(id)}/siteaudit/info`, {});
  if (!json) return { data: empty, meta: m };
  const q = json.quality || {};
  return {
    data: {
      configured: true,
      status: typeof json.status === 'string' ? json.status : null,
      health: num(q.value),
      healthDelta: num(q.delta),
      errors: num(json.errors),
      warnings: num(json.warnings),
      notices: num(json.notices),
      pagesCrawled: num(json.pages_crawled),
      pagesHealthy: num(json.healthy),
      pagesWithIssues: num(json.haveIssues),
      lastAudit: json.last_audit ? new Date(Number(json.last_audit) * 1000).toISOString() : null,
    },
    meta: m,
  };
}

// Recursively hunt for numeric fields in unfamiliar JSON shapes (the tracking
// report format varies by campaign type — parse defensively, never throw).
function deepFindNumbers(obj: any, key: string, out: number[] = [], depth = 0): number[] {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === key.toLowerCase()) {
      const n = num(v as any);
      if (n != null) out.push(n);
    }
    if (v && typeof v === 'object') deepFindNumbers(v, key, out, depth + 1);
  }
  return out;
}

export async function trackingSummary(domain: string): Promise<{ data: TrackingSummary; meta: SectionMeta }> {
  const id = projectId();
  const empty: TrackingSummary = { configured: Boolean(id), visibility: null, visibilityDelta: null, avgPosition: null, trend: [] };
  if (!id) return { data: empty, meta: { ok: false, source: 'none', reason: 'no_token', note: 'SEMRUSH_PROJECT_ID not set', unitsSpent: 0 } };

  const end = new Date();
  const begin = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const { json, meta: m } = await projectJson(
    'tracking_report',
    id + ':' + fmt(begin).slice(0, 6),
    `/reports/v1/projects/${encodeURIComponent(id)}/tracking/`,
    {
      action: 'report',
      type: 'tracking_visibility_organic',
      date_begin: fmt(begin),
      date_end: fmt(end),
      url: '*.' + domain + '/*',
    }
  );
  if (!json) return { data: empty, meta: m };

  // Expected shape: { data: { "YYYYMMDD": { Vi: ..., Av: ... }, ... } } — but
  // tolerate variations by walking whatever came back.
  const trend: TrackingPoint[] = [];
  const data = json.data && typeof json.data === 'object' ? json.data : json;
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (/^\d{8}$/.test(k) && v && typeof v === 'object') {
        const vi = deepFindNumbers(v, 'Vi')[0] ?? deepFindNumbers(v, 'visibility')[0] ?? null;
        trend.push({ date: k.slice(0, 4) + '-' + k.slice(4, 6) + '-' + k.slice(6, 8), visibility: vi });
      }
    }
  }
  trend.sort((a, b) => a.date.localeCompare(b.date));
  const withVis = trend.filter((t) => t.visibility != null);
  const latest = withVis.length ? withVis[withVis.length - 1].visibility : null;
  const first = withVis.length ? withVis[0].visibility : null;
  const avgPos = deepFindNumbers(json, 'Av')[0] ?? null;
  return {
    data: {
      configured: true,
      visibility: latest,
      visibilityDelta: latest != null && first != null ? Math.round((latest - first) * 100) / 100 : null,
      avgPosition: avgPos,
      trend,
    },
    meta: m,
  };
}

// ---------------------------------------------------------------------------
// The bundle: one call powers the whole panel.
// ---------------------------------------------------------------------------

export async function domainBundle(rawDomain?: string): Promise<DomainBundle> {
  const domain = normalizeDomain(rawDomain || '') || primaryDomain();
  const [ov, bl, kw, comp, balance] = await Promise.all([
    domainOverview(domain),
    backlinksOverview(domain),
    topOrganicKeywords(domain, 15),
    organicCompetitors(domain, 5),
    getUnitsBalance(),
  ]);
  return {
    domain,
    isPrimaryDomain: domain === primaryDomain(),
    overview: ov.data,
    overviewMeta: ov.meta,
    backlinks: bl.data,
    backlinksMeta: bl.meta,
    topKeywords: kw.rows,
    topKeywordsMeta: kw.meta,
    competitors: comp.rows,
    competitorsMeta: comp.meta,
    balance,
    unitsSpent: ov.meta.unitsSpent + bl.meta.unitsSpent + kw.meta.unitsSpent + comp.meta.unitsSpent,
  };
}

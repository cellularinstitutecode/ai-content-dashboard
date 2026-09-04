// web/lib/semrush-transport.ts
// How a Semrush report request leaves the app: over the Standard API (v3) or
// over Semrush's MCP server. Pure and dependency-free so the mapping and the
// wire protocol can be unit-tested with an injected fetch.
//
// Why two transports exist. Every report the app uses is a Standard API (v3)
// report. The v3 HTTP endpoints accept only a v3 key, which is a Business-plan
// entitlement; the API Keys page on a Pro plan issues v4 keys (`semrtkn-…`),
// which v3 answers with ERROR 122 / HTTP 403 and which cannot read the free
// balance endpoint either. Semrush's MCP server (`mcp.semrush.com/v2/mcp`)
// accepts that same v4 key with `Authorization: Apikey …` and runs the same
// v3 reports on the account's API units, returning the same semicolon-CSV —
// so the parsers in lib/semrush.ts and lib/semrush-domain.ts work unchanged.
// Proven against the live account before this was written (phrase_related,
// domain_ranks, resource_organic, domain_organic_organic, backlinks_overview
// all came back with the v3 headers the parsers key on).
//
// The MCP server validates parameters by NAME, not by v3 code, so the tables
// below translate the app's v3 vocabulary (`Ph,Nq,Cp,Kd,In`, `nq_desc`) into
// the MCP vocabulary (`keyword, volume, cpc, keyword_difficulty, intent`,
// `volume_desc`). A report or column with no translation is refused here, as
// `null`, rather than sent and rejected upstream.

export type SemrushTransport = 'v3' | 'mcp';

export const DEFAULT_MCP_URL = 'https://mcp.semrush.com/v2/mcp';

/** A v4 personal access token, the only kind the API Keys page issues today. */
export function looksLikeV4Key(key: string | undefined | null): boolean {
  return /^semrtkn-/i.test((key || '').trim());
}

/**
 * Which transport to use for this key.
 *
 * `override` is SEMRUSH_TRANSPORT: 'v3' or 'mcp' force a transport; anything
 * else (unset, 'auto') decides by key shape — a v4 token can only work over
 * MCP, everything else is assumed to be a v3 key.
 */
export function transportFor(key: string | undefined | null, override?: string | null): SemrushTransport {
  const o = (override || '').trim().toLowerCase();
  if (o === 'v3' || o === 'mcp') return o;
  return looksLikeV4Key(key) ? 'mcp' : 'v3';
}

// ---------------------------------------------------------------------------
// v3 → MCP vocabulary
// ---------------------------------------------------------------------------

type ReportMap = {
  /** MCP report name (the toolkit's name for the same v3 report). */
  report: string;
  /** v3 column code → MCP column name. */
  columns: Record<string, string>;
  /** v3 display_sort → MCP display_sort. */
  sorts: Record<string, string>;
  /** v3 parameter name → MCP parameter name (identity if absent). */
  params?: Record<string, string>;
};

const KEYWORD_COLUMNS: Record<string, string> = {
  Ph: 'keyword',
  Nq: 'volume',
  Cp: 'cpc',
  Co: 'competitive_density',
  Nr: 'results',
  Td: 'trend',
  Kd: 'keyword_difficulty',
  In: 'intent',
  Fk: 'triggered_serp_features',
};

const KEYWORD_SORTS: Record<string, string> = {
  nq_desc: 'volume_desc',
  nq_asc: 'volume_asc',
  cp_desc: 'cpc_desc',
  cp_asc: 'cpc_asc',
  kd_desc: 'keyword_difficulty_desc',
  kd_asc: 'keyword_difficulty_asc',
  co_desc: 'competitive_density_desc',
  co_asc: 'competitive_density_asc',
};

const REPORTS: Record<string, ReportMap> = {
  // Keyword Analytics — same names on both sides.
  phrase_related: { report: 'phrase_related', columns: KEYWORD_COLUMNS, sorts: KEYWORD_SORTS },
  phrase_questions: { report: 'phrase_questions', columns: KEYWORD_COLUMNS, sorts: KEYWORD_SORTS },
  phrase_this: { report: 'phrase_this', columns: KEYWORD_COLUMNS, sorts: KEYWORD_SORTS },
  phrase_these: { report: 'phrase_these', columns: KEYWORD_COLUMNS, sorts: KEYWORD_SORTS },
  phrase_organic: {
    report: 'phrase_organic',
    columns: { Dn: 'domain', Ur: 'url', Po: 'position', Pt: 'position_type', Fk: 'triggered_serp_features' },
    sorts: {},
  },
  // Domain Overview: `domain` becomes `target`.
  domain_ranks: {
    report: 'domain_ranks',
    columns: {
      Db: 'database',
      Dt: 'date',
      Dn: 'domain',
      Rk: 'rank',
      Or: 'organic_keywords',
      Ot: 'organic_traffic',
      Oc: 'organic_traffic_cost',
      Ad: 'paid_keywords',
      At: 'paid_traffic',
      Ac: 'paid_traffic_cost',
    },
    sorts: {},
    params: { domain: 'target' },
  },
  // Organic Research: v3 `domain_organic` is MCP `resource_organic`.
  domain_organic: {
    report: 'resource_organic',
    columns: {
      Ph: 'keyword',
      Po: 'position',
      Pp: 'previous_position',
      Pd: 'position_difference',
      Nq: 'volume',
      Cp: 'cpc',
      Ur: 'url',
      Tr: 'traffic',
      Tg: 'traffic_share',
      Tc: 'traffic_cost_share',
      Co: 'competitive_density',
      Nr: 'results',
      Td: 'trend',
      Kd: 'keyword_difficulty',
      In: 'intent',
      Fp: 'domain_serp_features',
      Fk: 'triggered_serp_features',
      Ts: 'timestamp',
    },
    sorts: {
      tr_desc: 'traffic_desc',
      tr_asc: 'traffic_asc',
      nq_desc: 'volume_desc',
      nq_asc: 'volume_asc',
      po_asc: 'position_asc',
      po_desc: 'position_desc',
      kd_desc: 'keyword_difficulty_desc',
      kd_asc: 'keyword_difficulty_asc',
      cp_desc: 'cpc_desc',
      cp_asc: 'cpc_asc',
    },
    params: { domain: 'target' },
  },
  // Competitive Research — same name, keeps `domain`.
  domain_organic_organic: {
    report: 'domain_organic_organic',
    columns: {
      Dn: 'domain',
      Cr: 'competition_level',
      Np: 'common_keywords',
      Or: 'organic_keywords',
      Ot: 'organic_traffic',
      Oc: 'organic_traffic_cost',
      Ad: 'paid_keywords',
    },
    sorts: {
      np_desc: 'common_keywords_desc',
      np_asc: 'common_keywords_asc',
      cr_desc: 'competition_level_desc',
      cr_asc: 'competition_level_asc',
    },
  },
  // Backlink Analytics — v3 already uses the long column names.
  backlinks_overview: {
    report: 'backlinks_overview',
    columns: {
      ascore: 'authority_score',
      total: 'total',
      domains_num: 'domains_num',
      urls_num: 'urls_num',
      ips_num: 'ips_num',
      follows_num: 'follows_num',
      nofollows_num: 'nofollows_num',
      texts_num: 'texts_num',
      images_num: 'images_num',
      forms_num: 'forms_num',
      frames_num: 'frames_num',
      sponsored_num: 'sponsored_num',
    },
    sorts: {},
  },
  backlinks_refdomains: {
    report: 'backlinks_refdomains',
    columns: {
      domain_ascore: 'domain_ascore',
      domain: 'domain',
      backlinks_num: 'backlinks_num',
      ip: 'ip',
      country: 'country',
      first_seen: 'first_seen',
      last_seen: 'last_seen',
    },
    sorts: {},
  },
};

export type McpCall = { report: string; params: Record<string, unknown> };

/**
 * Translate a v3 report request into an MCP `execute_report` call.
 * Returns null when the report, a column or a sort has no MCP equivalent —
 * the caller then reports 'plan' rather than sending something upstream will
 * reject.
 */
export function toMcpCall(report: string, v3params: Record<string, string>): McpCall | null {
  const map = REPORTS[report];
  if (!map) return null;
  const params: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(v3params)) {
    const key = map.params?.[rawKey] ?? rawKey;
    if (rawKey === 'key' || rawKey === 'type') continue;
    if (rawKey === 'export_columns') {
      const cols = String(rawValue)
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const mapped: string[] = [];
      for (const c of cols) {
        const m = map.columns[c];
        if (!m) return null;
        mapped.push(m);
      }
      params.export_columns = mapped;
      continue;
    }
    if (rawKey === 'display_sort') {
      const m = map.sorts[String(rawValue)];
      if (!m) return null;
      params.display_sort = m;
      continue;
    }
    if (rawKey === 'display_limit' || rawKey === 'display_offset') {
      const n = parseInt(String(rawValue), 10);
      if (Number.isFinite(n)) params[key] = n;
      continue;
    }
    params[key] = rawValue;
  }
  return { report: map.report, params };
}

/**
 * The two Projects API calls the app makes, as MCP reports. Both take the
 * project id; position tracking is keyed by campaign id, which for a project
 * with one campaign is the project id — the same id the v3 path used.
 */
export function toMcpProjectCall(
  kind: 'siteaudit_info' | 'tracking_report',
  projectId: string,
  v3params: Record<string, string>
): McpCall | null {
  const id = parseInt(projectId, 10);
  if (!Number.isFinite(id)) return null;
  if (kind === 'siteaudit_info') return { report: 'info', params: { id } };
  if (kind === 'tracking_report') {
    const iso = (s: string | undefined) => (s && /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s);
    const params: Record<string, unknown> = { campaign_id: String(id) };
    if (v3params.url) params.url = v3params.url;
    if (v3params.date_begin) params.date_begin = iso(v3params.date_begin);
    if (v3params.date_end) params.date_end = iso(v3params.date_end);
    return { report: 'tracking_visibility_organic', params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The wire: MCP over Streamable HTTP (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

export type McpResponse = {
  /** 200 with the report text; the upstream HTTP status when the server refused. */
  status: number;
  /** The report body (v3 CSV / JSON), or the server's error text. */
  text: string;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type McpClientOptions = {
  key: string;
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

// One MCP session per server process. The server may hand back a session id
// on `initialize`; it is replayed on every later call and dropped (so the next
// call re-initialises) when the server says it no longer knows it.
let session: { url: string; key: string; id: string | null } | null = null;

/** Test hook: forget the cached session. */
export function resetMcpSession(): void {
  session = null;
}

function parseRpcBody(raw: string, contentType: string | null): any {
  const text = (raw || '').trim();
  if (!text) return null;
  if ((contentType || '').includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    // Server-sent events: take the last JSON `data:` payload with a result or error.
    let last: any = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const j = JSON.parse(payload);
        if (j && (j.result !== undefined || j.error !== undefined)) last = j;
      } catch {
        /* keep scanning */
      }
    }
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rpc(
  opts: McpClientOptions,
  body: Record<string, unknown>,
  sessionId: string | null
): Promise<{ status: number; json: any; sessionId: string | null; raw: string }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = opts.url || DEFAULT_MCP_URL;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Apikey ' + opts.key,
    'mcp-protocol-version': '2025-03-26',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    const raw = await res.text().catch(() => '');
    const sid = res.headers?.get?.('mcp-session-id') ?? sessionId;
    return { status: res.status, json: parseRpcBody(raw, res.headers?.get?.('content-type') ?? null), sessionId: sid, raw };
  } finally {
    clearTimeout(to);
  }
}

async function ensureSession(opts: McpClientOptions): Promise<string | null> {
  const url = opts.url || DEFAULT_MCP_URL;
  if (session && session.url === url && session.key === opts.key) return session.id;
  const init = await rpc(
    opts,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'content-studio', version: '1' },
      },
    },
    null
  );
  if (init.status === 401 || init.status === 403) {
    throw Object.assign(new Error('mcp initialize refused'), { status: init.status, body: init.raw });
  }
  if (init.status >= 400) {
    throw Object.assign(new Error('mcp initialize failed'), { status: init.status, body: init.raw });
  }
  session = { url, key: opts.key, id: init.sessionId };
  // Fire-and-forget by contract; errors here are not the report's problem.
  await rpc(opts, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId).catch(() => undefined);
  return init.sessionId;
}

function toolText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n')
    .trim();
}

/**
 * The MCP tool wraps a v3 failure as `get phrase_related: ERROR 50 :: NOTHING
 * FOUND` followed by advice. The callers recognise `ERROR NN` at the START of
 * the body (that is where v3 puts it), so lift it to the front.
 */
export function normalizeToolError(text: string): string {
  const m = /ERROR\s+\d+\s*::[^\n]*/i.exec(text || '');
  if (m) return m[0].trim();
  return (text || '').trim() || 'ERROR 0 :: mcp tool error';
}

/**
 * Run one report through the MCP server and hand back what the v3 endpoint
 * would have: the CSV/JSON text with status 200, or the failure.
 *
 * Failure shapes, so the callers' existing v3 handling keeps working:
 * - the server refuses the key → the HTTP status (401/403) and its body
 * - the tool reports `isError` → status 200 and the tool's text, which for the
 *   v3-derived errors is the familiar `ERROR NN :: …` line
 * - a JSON-RPC error → status 502 and the error message
 */
export async function mcpExecuteReport(opts: McpClientOptions, call: McpCall): Promise<McpResponse> {
  const attempt = async (retryOnLostSession: boolean): Promise<McpResponse> => {
    let sid: string | null;
    try {
      sid = await ensureSession(opts);
    } catch (e: any) {
      if (typeof e?.status === 'number') return { status: e.status, text: String(e.body || e.message || '').slice(0, 300) };
      throw e; // a network failure — the caller already maps thrown errors to 'network'
    }
    const r = await rpc(
      opts,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'execute_report', arguments: { report: call.report, params: call.params } },
      },
      sid
    );
    if (r.status === 401 || r.status === 403) return { status: r.status, text: r.raw.slice(0, 300) };
    const lostSession = r.status === 404 || r.status === 400 || (r.json?.error && /session/i.test(String(r.json.error.message || '')));
    if (lostSession && retryOnLostSession) {
      session = null;
      return attempt(false);
    }
    if (r.status >= 400) return { status: r.status, text: r.raw.slice(0, 300) };
    if (r.json?.error) return { status: 502, text: String(r.json.error.message || 'mcp error').slice(0, 300) };
    const text = toolText(r.json?.result);
    if (r.json?.result?.isError) return { status: 200, text: normalizeToolError(text) };
    return { status: 200, text };
  };
  return attempt(true);
}

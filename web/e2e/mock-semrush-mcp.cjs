// A stand-in for mcp.semrush.com/v2/mcp — the door a v4 (Pro-plan) key goes
// through. Speaks just enough MCP over Streamable HTTP for lib/semrush-transport:
// initialize (hands out a session id), notifications/initialized, and
// tools/call for execute_report. Answers with the SAME semicolon-CSV the real
// server returned on the live account, so the app's v3 parsers are exercised
// for real. Validates parameter NAMES the way the real server does, so a v3
// code (`Ph`, `nq_desc`) leaking through would fail here too.
//
// Point the app at it with SEMRUSH_MCP_URL=http://127.0.0.1:54323 and a
// v4-shaped key (SEMRUSH_API_KEY=semrtkn-e2e-…). Requires the Authorization
// header to be exactly `Apikey <that key>` — a missing or mangled key is 401,
// which is what the real server does.
//
// Introspection for the suite: GET /__calls lists every tools/call received;
// POST /__reset clears it; POST /__fail {"report":"phrase_related"} makes that
// report answer with a JSON-RPC error until the next reset.
const http = require('http');

const KEY = process.env.MOCK_SEMRUSH_KEY || 'semrtkn-e2e-0000';
const PORT = 54323;

const KW_ENUM = new Set(['keyword', 'volume', 'cpc', 'competitive_density', 'results', 'trend', 'relevance', 'triggered_serp_features', 'intent', 'keyword_difficulty']);
const KW_SORT = new Set(['volume_asc', 'volume_desc', 'cpc_asc', 'cpc_desc', 'keyword_difficulty_asc', 'keyword_difficulty_desc', 'competitive_density_asc', 'competitive_density_desc']);
const HEADERS = {
  keyword: 'Keyword', volume: 'Search Volume', cpc: 'CPC', keyword_difficulty: 'Keyword Difficulty Index', intent: 'Intent',
  competitive_density: 'Competition', results: 'Number of Results', trend: 'Trend', relevance: 'Relevance', triggered_serp_features: 'SERP Features',
  domain: 'Domain', url: 'Url', position: 'Position',
  database: 'Database', rank: 'Rank', organic_keywords: 'Organic Keywords', organic_traffic: 'Organic Traffic', organic_traffic_cost: 'Organic Cost',
  paid_keywords: 'Adwords Keywords', paid_traffic: 'Adwords Traffic', paid_traffic_cost: 'Adwords Cost',
  previous_position: 'Previous Position', position_difference: 'Position Difference', traffic: 'Traffic',
  competition_level: 'Competitor Relevance', common_keywords: 'Common Keywords',
  authority_score: 'ascore', total: 'total', domains_num: 'domains_num', urls_num: 'urls_num', ips_num: 'ips_num', follows_num: 'follows_num', nofollows_num: 'nofollows_num', texts_num: 'texts_num', images_num: 'images_num',
};

// Rows keyed by MCP column name; the CSV is assembled in the order asked for.
const DATA = {
  phrase_related: [
    { keyword: 'exosome therapy for joint pain', volume: 1900, cpc: 4.12, keyword_difficulty: 34, intent: '1' },
    { keyword: 'exosome injection knee', volume: 720, cpc: 3.4, keyword_difficulty: 22, intent: '1,0' },
    { keyword: 'exosome therapy cost', volume: 590, cpc: 5.1, keyword_difficulty: 29, intent: '0' },
  ],
  phrase_questions: [
    { keyword: 'does exosome therapy work for knees', volume: 210, cpc: 2.2, keyword_difficulty: 18, intent: '1' },
    { keyword: 'how long does exosome therapy last', volume: 170, cpc: 1.9, keyword_difficulty: 15, intent: '1' },
  ],
  phrase_organic: [
    { domain: 'cellularhopeinstitute.com', url: 'https://www.cellularhopeinstitute.com/exosomes/' },
    { domain: 'example-competitor.com', url: 'https://example-competitor.com/exosome-therapy' },
  ],
  domain_ranks: [
    { database: 'us', domain: 'cellularhopeinstitute.com', rank: 1209589, organic_keywords: 1129, organic_traffic: 881, organic_traffic_cost: 961, paid_keywords: 0, paid_traffic: 0, paid_traffic_cost: 0 },
  ],
  resource_organic: [
    { keyword: 'cellular hope institute', position: 1, previous_position: 1, position_difference: 0, volume: 140, cpc: 4.43, url: 'https://www.cellularhopeinstitute.com/', traffic: 112, keyword_difficulty: '20.00', intent: '2' },
    { keyword: 'stem cell therapy mexico', position: 7, previous_position: 7, position_difference: 0, volume: 1900, cpc: 0, url: 'https://www.cellularhopeinstitute.com/is-stem-cell-therapy-in-mexico-safe/', traffic: 24, keyword_difficulty: '26.00', intent: '0' },
  ],
  domain_organic_organic: [
    { domain: 'bookimed.com', competition_level: '0.01', common_keywords: 136, organic_keywords: 48982, organic_traffic: 45937, organic_traffic_cost: 53809 },
  ],
  backlinks_overview: [
    { authority_score: 11, total: 417, domains_num: 206, urls_num: 368, ips_num: 162, follows_num: 339, nofollows_num: 78, texts_num: 397, images_num: 20 },
  ],
};

const REQUIRED = {
  phrase_related: ['phrase', 'database'], phrase_questions: ['phrase', 'database'], phrase_organic: ['phrase', 'database'],
  domain_ranks: ['target'], resource_organic: ['target', 'database'], domain_organic_organic: ['domain', 'database'],
  backlinks_overview: ['target', 'target_type'],
};

let calls = [];
let failing = new Set();
let sessions = new Set();

function csvFor(report, params) {
  const rows = DATA[report];
  if (!rows) return { error: 'unknown report' };
  for (const p of REQUIRED[report] || []) if (params[p] == null || params[p] === '') return { error: "parameter '" + p + "' is required" };
  // The real server rejects v3 codes by name; do the same for the keyword family.
  if (/^phrase_(related|questions|this|these)$/.test(report)) {
    for (const c of params.export_columns || []) if (!KW_ENUM.has(c)) return { error: "parameter 'export_columns' must be one of: " + [...KW_ENUM].join(' ') };
    if (params.display_sort && !KW_SORT.has(params.display_sort)) return { error: "parameter 'display_sort' must be one of: " + [...KW_SORT].join(' ') };
  }
  if (params.export_columns && !Array.isArray(params.export_columns)) return { error: 'json: cannot unmarshal string into Go struct field alias.export_columns of type []string' };
  if (/nothing|zxqv/i.test(String(params.phrase || ''))) return { toolError: 'get ' + report + ': ERROR 50 :: NOTHING FOUND\nNo data found for this request.' };
  const cols = params.export_columns && params.export_columns.length ? params.export_columns : Object.keys(rows[0]);
  const limit = Number(params.display_limit) > 0 ? Number(params.display_limit) : rows.length;
  const header = cols.map((c) => HEADERS[c] || c).join(';');
  const body = rows.slice(0, limit).map((r) => cols.map((c) => (r[c] == null ? '' : String(r[c]))).join(';')).join('\n');
  return { text: header + '\n' + body };
}

function rpcResult(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  let raw = '';
  for await (const chunk of req) raw += chunk;

  if (url.pathname === '/__calls') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(calls)); }
  if (url.pathname === '/__reset') { calls = []; failing = new Set(); sessions = new Set(); res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/__fail') { try { failing.add(JSON.parse(raw).report); } catch {} res.writeHead(200); return res.end('ok'); }

  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  if (req.headers.authorization !== 'Apikey ' + KEY) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Unauthorized'); }

  let msg;
  try { msg = JSON.parse(raw); } catch { res.writeHead(400); return res.end('bad json'); }

  if (msg.method === 'initialize') {
    const sid = 'sess-' + Math.random().toString(36).slice(2, 10);
    sessions.add(sid);
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
    return res.end(rpcResult(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-semrush-mcp', version: '0' } }));
  }
  if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }

  // Everything else needs a session the server handed out.
  const sid = req.headers['mcp-session-id'];
  if (!sid || !sessions.has(sid)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('session not found'); }

  if (msg.method === 'tools/call' && msg.params?.name === 'execute_report') {
    const { report, params = {} } = msg.params.arguments || {};
    calls.push({ report, params, session: sid });
    if (failing.has(report)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(rpcError(msg.id, -32603, 'upstream unavailable')); }
    const out = csvFor(report, params);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (out.error) return res.end(rpcError(msg.id, -32602, out.error));
    if (out.toolError) return res.end(rpcResult(msg.id, { isError: true, content: [{ type: 'text', text: out.toolError }] }));
    return res.end(rpcResult(msg.id, { content: [{ type: 'text', text: out.text }] }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(rpcError(msg.id ?? null, -32601, 'method not found'));
});

server.listen(PORT, '127.0.0.1', () => console.log('mock semrush mcp on http://127.0.0.1:' + PORT));

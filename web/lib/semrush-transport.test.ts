// The MCP transport exists so a Pro-plan v4 key can run the app's v3 reports.
// Two things can go wrong silently: the vocabulary translation (the MCP server
// validates parameter NAMES and rejects v3 codes outright), and the wire
// protocol (sessions, SSE bodies, error wrapping). Both are pinned here with an
// injected fetch, so no test ever spends a unit of the clinic's account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeV4Key,
  transportFor,
  toMcpCall,
  toMcpProjectCall,
  normalizeToolError,
  mcpExecuteReport,
  resetMcpSession,
} from './semrush-transport.ts';

// --- Which door -----------------------------------------------------------
test('a semrtkn- token is a v4 key and goes over MCP; anything else is assumed v3', () => {
  assert.equal(looksLikeV4Key('semrtkn-pat-abc'), true);
  assert.equal(looksLikeV4Key('0123456789abcdef0123456789abcdef'), false);
  assert.equal(transportFor('semrtkn-pat-abc'), 'mcp');
  assert.equal(transportFor('0123456789abcdef0123456789abcdef'), 'v3');
  assert.equal(transportFor(undefined), 'v3');
});

test('SEMRUSH_TRANSPORT forces a transport regardless of key shape', () => {
  assert.equal(transportFor('semrtkn-pat-abc', 'v3'), 'v3');
  assert.equal(transportFor('0123456789abcdef', 'mcp'), 'mcp');
  assert.equal(transportFor('0123456789abcdef', 'auto'), 'v3');
  assert.equal(transportFor('semrtkn-pat-abc', ''), 'mcp');
});

// --- Vocabulary -------------------------------------------------------------
test('the keyword brief request translates exactly as the live server accepted it', () => {
  // These are the parameters lib/semrush.ts sends for phrase_related, and the
  // MCP form is what execute_report accepted on the live account.
  const call = toMcpCall('phrase_related', {
    phrase: 'stem cell therapy mexico',
    database: 'us',
    export_columns: 'Ph,Nq,Cp,Kd,In',
    display_limit: '12',
    display_sort: 'nq_desc',
  });
  assert.deepEqual(call, {
    report: 'phrase_related',
    params: {
      phrase: 'stem cell therapy mexico',
      database: 'us',
      export_columns: ['keyword', 'volume', 'cpc', 'keyword_difficulty', 'intent'],
      display_limit: 12,
      display_sort: 'volume_desc',
    },
  });
});

test('domain reports are renamed and re-keyed the way the MCP toolkits expect', () => {
  const ranks = toMcpCall('domain_ranks', { domain: 'cellularhopeinstitute.com', database: 'us', export_columns: 'Db,Dn,Rk,Or,Ot,Oc,Ad,At,Ac' });
  assert.equal(ranks?.report, 'domain_ranks');
  assert.equal(ranks?.params.target, 'cellularhopeinstitute.com');
  assert.equal('domain' in (ranks?.params ?? {}), false);
  assert.deepEqual(ranks?.params.export_columns, ['database', 'domain', 'rank', 'organic_keywords', 'organic_traffic', 'organic_traffic_cost', 'paid_keywords', 'paid_traffic', 'paid_traffic_cost']);

  const organic = toMcpCall('domain_organic', { domain: 'x.com', database: 'us', display_limit: '15', display_sort: 'tr_desc', export_columns: 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr,Kd,In' });
  assert.equal(organic?.report, 'resource_organic');
  assert.equal(organic?.params.target, 'x.com');
  assert.equal(organic?.params.display_sort, 'traffic_desc');

  const movers = toMcpCall('domain_organic', { domain: 'x.com', database: 'us', display_limit: '6', display_positions: 'new', display_sort: 'nq_desc', export_columns: 'Ph,Po,Pp,Pd,Nq,Kd,Ur' });
  assert.equal(movers?.params.display_positions, 'new');
  assert.equal(movers?.params.display_sort, 'volume_desc');

  const comp = toMcpCall('domain_organic_organic', { domain: 'x.com', database: 'us', display_limit: '5', display_sort: 'np_desc', export_columns: 'Dn,Cr,Np,Or,Ot,Oc' });
  assert.equal(comp?.report, 'domain_organic_organic');
  assert.equal(comp?.params.domain, 'x.com'); // this toolkit keeps `domain`
  assert.equal(comp?.params.display_sort, 'common_keywords_desc');

  const bl = toMcpCall('backlinks_overview', { target: 'x.com', target_type: 'root_domain', export_columns: 'ascore,total,domains_num' });
  assert.deepEqual(bl?.params.export_columns, ['authority_score', 'total', 'domains_num']);
  assert.equal(bl?.params.target_type, 'root_domain');
});

test('an unknown report, column or sort is refused here instead of sent upstream', () => {
  assert.equal(toMcpCall('domain_adwords', { domain: 'x.com' }), null);
  assert.equal(toMcpCall('phrase_related', { phrase: 'x', database: 'us', export_columns: 'Ph,Zz' }), null);
  assert.equal(toMcpCall('phrase_related', { phrase: 'x', database: 'us', display_sort: 'zz_desc' }), null);
});

test('the key never rides along into MCP parameters', () => {
  const call = toMcpCall('phrase_questions', { key: 'semrtkn-secret', type: 'phrase_questions', phrase: 'x', database: 'us', export_columns: 'Ph' });
  assert.equal(JSON.stringify(call).includes('secret'), false);
  assert.equal('type' in (call?.params ?? {}), false);
});

test('project reports map to the MCP site-audit and position-tracking reports', () => {
  assert.deepEqual(toMcpProjectCall('siteaudit_info', '12833067', {}), { report: 'info', params: { id: 12833067 } });
  const t = toMcpProjectCall('tracking_report', '12833067', { action: 'report', type: 'tracking_visibility_organic', date_begin: '20260806', date_end: '20260904', url: '*.x.com/*' });
  assert.deepEqual(t, { report: 'tracking_visibility_organic', params: { campaign_id: '12833067', url: '*.x.com/*', date_begin: '2026-08-06', date_end: '2026-09-04' } });
  assert.equal(toMcpProjectCall('siteaudit_info', '', {}), null);
});

// --- Error shape --------------------------------------------------------------
test('the tool wraps v3 errors mid-sentence; they are lifted to where the parsers look', () => {
  const wrapped = 'get phrase_related: ERROR 50 :: NOTHING FOUND\nNo data found for this request. Verify your parameters are correct.';
  assert.equal(normalizeToolError(wrapped), 'ERROR 50 :: NOTHING FOUND');
  assert.match(normalizeToolError('something else entirely'), /^something else/);
  assert.match(normalizeToolError(''), /^ERROR 0 ::/);
});

// --- The wire -------------------------------------------------------------------
type Call = { url: string; init: RequestInit; body: any };

type Scripted = { status: number; body: string; headers?: Record<string, string> };
function fakeFetch(script: (call: Call, n: number) => Scripted) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const call = { url, init, body };
    calls.push(call);
    const r = script(call, calls.length);
    const headers = new Headers(r.headers ?? { 'content-type': 'application/json' });
    return new Response(r.body, { status: r.status, headers });
  };
  return { impl, calls };
}

const CSV = 'Keyword;Search Volume;CPC;Keyword Difficulty Index;Intent\ncpi tijuana;1000;1.08;26;2';

test('initialize → initialized → tools/call, with the key as Apikey and the session replayed', async () => {
  resetMcpSession();
  const f = fakeFetch((call): Scripted => {
    if (call.body?.method === 'initialize') {
      const r: Scripted = { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'semrush' } } }), headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } };
      return r;
    }
    if (call.body?.method === 'notifications/initialized') return { status: 202, body: '' };
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: CSV }] } }) };
  });
  const r = await mcpExecuteReport({ key: 'semrtkn-pat-x', url: 'https://mcp.example/v2/mcp', fetchImpl: f.impl }, { report: 'phrase_related', params: { phrase: 'x', database: 'us' } });
  assert.equal(r.status, 200);
  assert.equal(r.text, CSV);
  assert.deepEqual(f.calls.map((c) => c.body?.method), ['initialize', 'notifications/initialized', 'tools/call']);
  for (const c of f.calls) {
    const h = c.init.headers as Record<string, string>;
    assert.equal(h.authorization, 'Apikey semrtkn-pat-x');
    assert.equal(c.url, 'https://mcp.example/v2/mcp');
  }
  const h = f.calls[2].init.headers as Record<string, string>;
  assert.equal(h['mcp-session-id'], 'sess-1');
  assert.deepEqual(f.calls[2].body.params, { name: 'execute_report', arguments: { report: 'phrase_related', params: { phrase: 'x', database: 'us' } } });
});

test('the session is reused across calls, and the SSE body form is understood', async () => {
  resetMcpSession();
  const f = fakeFetch((call): Scripted => {
    if (call.body?.method === 'initialize') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-2' } };
    if (call.body?.method === 'notifications/initialized') return { status: 202, body: '' };
    const sse = 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: CSV }] } }) + '\n\n';
    return { status: 200, body: sse, headers: { 'content-type': 'text/event-stream' } };
  });
  const opts = { key: 'semrtkn-pat-x', url: 'https://mcp.example/v2/mcp', fetchImpl: f.impl };
  const a = await mcpExecuteReport(opts, { report: 'phrase_related', params: { phrase: 'a', database: 'us' } });
  const b = await mcpExecuteReport(opts, { report: 'phrase_related', params: { phrase: 'b', database: 'us' } });
  assert.equal(a.text, CSV);
  assert.equal(b.text, CSV);
  // one handshake (2 calls) + two tool calls
  assert.deepEqual(f.calls.map((c) => c.body?.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
});

test('a lost session re-initialises once and retries; a refused key surfaces its status', async () => {
  resetMcpSession();
  let toolCalls = 0;
  const f = fakeFetch((call): Scripted => {
    if (call.body?.method === 'initialize') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-' + call.body.id } };
    if (call.body?.method === 'notifications/initialized') return { status: 202, body: '' };
    toolCalls += 1;
    if (toolCalls === 1) return { status: 404, body: 'session not found' };
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: CSV }] } }) };
  });
  const r = await mcpExecuteReport({ key: 'semrtkn-pat-x', url: 'https://mcp.example/v2/mcp', fetchImpl: f.impl }, { report: 'phrase_related', params: { phrase: 'x', database: 'us' } });
  assert.equal(r.status, 200);
  assert.equal(r.text, CSV);
  assert.equal(toolCalls, 2);

  resetMcpSession();
  const g = fakeFetch(() => ({ status: 401, body: 'Unauthorized' }));
  const refused = await mcpExecuteReport({ key: 'semrtkn-bad', url: 'https://mcp.example/v2/mcp', fetchImpl: g.impl }, { report: 'phrase_related', params: {} });
  assert.equal(refused.status, 401);
});

test('a tool error comes back as a v3-shaped ERROR line with status 200, a JSON-RPC error as 502', async () => {
  resetMcpSession();
  const f = fakeFetch((call): Scripted => {
    if (call.body?.method === 'initialize') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) };
    if (call.body?.method === 'notifications/initialized') return { status: 202, body: '' };
    if (call.body?.params?.arguments?.params?.phrase === 'nothing') {
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'get phrase_related: ERROR 50 :: NOTHING FOUND\nNo data found.' }] } }) };
    }
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Invalid params' } }) };
  });
  const opts = { key: 'semrtkn-pat-x', url: 'https://mcp.example/v2/mcp', fetchImpl: f.impl };
  const empty = await mcpExecuteReport(opts, { report: 'phrase_related', params: { phrase: 'nothing' } });
  assert.equal(empty.status, 200);
  assert.equal(empty.text, 'ERROR 50 :: NOTHING FOUND');
  const bad = await mcpExecuteReport(opts, { report: 'phrase_related', params: { phrase: 'x' } });
  assert.equal(bad.status, 502);
  assert.match(bad.text, /Invalid params/);
});

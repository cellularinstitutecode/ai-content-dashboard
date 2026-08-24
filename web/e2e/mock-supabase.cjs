// Mock Supabase backend for end-to-end tests.
//
// Implements just enough of GoTrue (/auth/v1/*), PostgREST (/rest/v1/*) and
// Storage (/storage/v1/*) for the dashboard to boot, authenticate a session,
// and render every panel with deterministic seed data — no real Supabase, no
// network, no secrets. Run: node e2e/mock-supabase.cjs (listens on :54321)
const http = require('http');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'cellularhopeinstitute@gmail.com',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { name: 'Cellular Institute' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// A tiny valid JPEG (1x1, gray) served for every mock storage object.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAAC//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');

const now = Date.now();
const iso = (msFromNow) => new Date(now + msFromNow).toISOString();
const IMG = (name) => 'http://127.0.0.1:54321/storage/v1/object/public/content-images/' + name;

// ---------------------------------------------------------------------------
// Seed data — one of everything the dashboard renders.
// ---------------------------------------------------------------------------
const APPROVED = { status: 'approved', score: 93, issues: [], textDetected: false, model: 'gpt-4o-mini', checkedAt: iso(-3600e3) };
const TEXTFLAG = {
  status: 'flagged', score: 41, textDetected: true, model: 'gpt-4o-mini', checkedAt: iso(-1800e3),
  issues: ['visible text/letters detected — content images must be text-free'],
};

const tables = {
  drafts: [
    {
      id: 'draft-1', user_id: USER_ID, topic: 'Exosome therapy for joint recovery',
      audience: null, tone: null, goal: null, cta: null, channels: ['instagram', 'facebook'], provider: 'anthropic',
      created_at: iso(-86400e3), updated_at: iso(-3600e3),
      pack: {
        format: 'social',
        instagram: 'Exosome therapy is changing recovery timelines. #regenerativemedicine',
        facebook: 'How exosome therapy supports joint recovery — what patients ask us most.',
        linkedin: 'A measured look at exosome therapy for joint recovery.',
        blog: 'Exosome Therapy for Joint Recovery\nWhat the science says today...',
        _semrush: { checked: true, source: 'semrush', primary: 'exosome therapy', volume: 1900, difficulty: 34, keywords: ['exosome therapy', 'joint recovery'], questions: [], intent: 'informational', fromCache: true, unitsSpent: 0, checkedAt: iso(-86400e3) },
        _image: { url: IMG('draft-1.jpg'), prompt: 'p', alt: 'Exosome therapy — illustrative image', model: 'gpt-image-1', createdAt: iso(-3600e3), variant: 0, verification: APPROVED },
      },
    },
    {
      id: 'draft-2', user_id: USER_ID, topic: '[Autopilot] stem cell therapy for knees',
      audience: null, tone: null, goal: 'rank', cta: null, channels: ['instagram', 'linkedin'], provider: 'anthropic',
      created_at: iso(-7200e3), updated_at: iso(-1800e3),
      pack: {
        format: 'social',
        instagram: 'Stem cell therapy for knees: what candidates should know.',
        facebook: 'Considering stem cell therapy for knee pain? Start here.',
        linkedin: 'Stem cell therapy for knees — evidence and expectations.',
        blog: 'Stem Cell Therapy for Knees\nA practical guide...',
        _autopilot: { run_id: 'run-1', template_id: 'tpl-1', template_name: 'Weekly knees series', scheduled_for: iso(86400e3), angle: { type: 'answer', query: 'stem cell therapy for knees' } },
        _image: { url: IMG('draft-2.jpg'), prompt: 'p', alt: 'text-flagged image', model: 'gpt-image-1', createdAt: iso(-1800e3), variant: 1, verification: TEXTFLAG },
      },
    },
    {
      id: 'draft-3', user_id: USER_ID, topic: 'Ben Rothwell — Recovery clip',
      audience: null, tone: null, goal: null, cta: null, channels: null, provider: null,
      created_at: iso(-100000e3), updated_at: iso(-90000e3),
      pack: {
        kind: 'clip', projectId: 'opus-p1', status: 'ready', thumb: IMG('thumb-1.jpg'),
        caption: 'Recovery stories from the clinic.',
        clips: [
          { id: 'c1', title: 'The moment recovery clicked', text: 'clip', description: 'Best moment', hashtags: '#recovery', durationMs: 34000, preview: IMG('clip-1.mp4'), export: IMG('clip-1.mp4') },
        ],
      },
    },
    {
      id: 'draft-4', user_id: USER_ID, topic: 'Calm clinic interior visual',
      audience: null, tone: null, goal: null, cta: null, channels: null, provider: null,
      created_at: iso(-5000e3), updated_at: iso(-5000e3),
      pack: { kind: 'image', format: 'image', _image: { url: IMG('draft-4.jpg'), prompt: 'p', alt: 'Calm clinic interior', model: 'gpt-image-1', createdAt: iso(-5000e3), variant: 2, verification: APPROVED } },
    },
  ],
  posts: [
    { id: 'post-1', user_id: USER_ID, draft_id: 'draft-1', providers: ['facebook'], text: 'Scheduled: exosome therapy explainer', publication_date: iso(2 * 86400e3), metricool_post_id: 'mc-1', status: 'pending_review', created_at: iso(-3600e3) },
    { id: 'post-2', user_id: USER_ID, draft_id: null, providers: ['instagram'], text: 'Scheduled: recovery stories', publication_date: iso(4 * 86400e3), metricool_post_id: 'mc-2', status: 'scheduled', created_at: iso(-7200e3) },
  ],
  clips: [
    { id: 'clip-1', user_id: USER_ID, opus_project_id: 'opus-p1', source_url: 'https://youtu.be/t5lBhT3UFqg', result: [{ title: 'The moment recovery clicked', export: IMG('clip-1.mp4'), text: 'clip', hashtags: '#recovery' }], created_at: iso(-100000e3) },
  ],
  schedule_templates: [
    { id: 'tpl-1', user_id: USER_ID, name: 'Weekly knees series', providers: ['instagram', 'linkedin'], text: '', weekdays: [1, 3], time_of_day: '09:00', active: true, strategy: { mode: 'pillars', pillars: ['stem cell therapy for knees'], goal: 'rank', format: 'social', lead_hours: 24, max_regens: 1 }, updated_at: iso(-86400e3) },
  ],
  template_runs: [
    {
      id: 'run-1', template_id: 'tpl-1', user_id: USER_ID, scheduled_for: iso(86400e3), state: 'ready_for_review',
      attempts: 0, regens: 0, brief: null,
      angle: { type: 'answer', query: 'stem cell therapy for knees', seedTopic: 'stem cell therapy for knees', rationale: 'Real searcher question — answering it builds authority.', volume: 720, difficulty: 28, intent: 'informational' },
      score: { total: 84, breakdown: { keyword: 30, channels: 25, hook: 20, cta: 0, safety: 9 }, safetyFlags: [], critique: [] },
      draft_id: 'draft-2', log: [], updated_at: iso(-1800e3),
    },
  ],
  brand_profiles: [
    { id: 'brand-1', user_id: USER_ID, name: 'Cellular Hope Institute', mission: 'Physician-led regenerative medicine.', voice: 'Warm, credible, hopeful.', audience: 'Adults 40-70 researching regenerative options', keywords: ['stem cell therapy', 'exosomes'], guidelines: 'No medical claims.', updated_at: iso(-86400e3) },
  ],
  post_metrics: [],
  usage_events: [],
  draft_keywords: [],
  keyword_performance: [],
  semrush_cache: [],
  semrush_domain_cache: [],
  semrush_usage: [],
};

// ---------------------------------------------------------------------------
// A generous PostgREST subset: eq/in/gte/lt/not filters, order, limit/offset,
// exact counts (head or not), insert/upsert/patch/delete with representation.
// ---------------------------------------------------------------------------
function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    for (const value of params.getAll(key)) {
      const m = /^(eq|neq|gt|gte|lt|lte|in|is|not)\.(.*)$/s.exec(value);
      if (!m) continue;
      const [, op, operand] = m;
      // PostgREST JSON-path keys: pack->>kind / pack->meta->>type
      const lookup = (r) => {
        if (!key.includes('->')) return r[key];
        const parts = key.split(/->>|->/).filter(Boolean);
        let v = r;
        for (const p of parts) v = v == null ? undefined : v[p];
        return v;
      };
      out = out.filter((r) => {
        const v = lookup(r);
        if (op === 'eq') return String(v) === operand;
        if (op === 'neq') return String(v) !== operand;
        if (op === 'gt') return String(v) > operand;
        if (op === 'gte') return String(v) >= operand;
        if (op === 'lt') return String(v) < operand;
        if (op === 'lte') return String(v) <= operand;
        if (op === 'is') return operand === 'null' ? v == null : String(v) === operand;
        if (op === 'not') { const n = /^is\.null$/.test(operand); return n ? v != null : true; }
        if (op === 'in') {
          const list = operand.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
          return list.includes(String(v));
        }
        return true;
      });
    }
  }
  const order = params.get('order');
  if (order) {
    const [col, ...mods] = order.split('.');
    const desc = mods.includes('desc');
    out = [...out].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (desc ? -1 : 1));
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
  });
}

let reqLog = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:54321');
  reqLog.push(req.method + ' ' + url.pathname);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // --- introspection for the test harness ---
  if (url.pathname === '/__requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(reqLog));
  }
  if (url.pathname === '/__reset') { reqLog = []; res.writeHead(204); return res.end(); }

  // --- GoTrue ---
  if (url.pathname === '/auth/v1/user') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(USER));
  }
  if (url.pathname === '/auth/v1/token') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'e2e-access', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(now / 1000) + 3600, refresh_token: 'e2e-refresh', user: USER }));
  }
  if (url.pathname === '/auth/v1/logout') { res.writeHead(204); return res.end(); }

  // --- Storage (public objects + bucket admin used by image upload) ---
  if (url.pathname.startsWith('/storage/v1/object/public/')) {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' });
    return res.end(JPEG);
  }
  if (url.pathname.startsWith('/storage/v1/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ Key: 'content-images/mock', publicUrl: IMG('mock.jpg') }));
  }

  // --- Realtime (websocket upgrade requests just get a polite refusal) ---
  if (url.pathname.startsWith('/realtime/')) { res.writeHead(404); return res.end(); }

  // --- PostgREST ---
  const rest = /^\/rest\/v1\/([a-zA-Z0-9_]+)$/.exec(url.pathname);
  if (rest) {
    const table = rest[1];
    if (!(table in tables)) tables[table] = [];
    const rows = tables[table];
    const prefer = String(req.headers.prefer || '');
    const wantCount = /count=exact/.test(prefer);
    const isHead = req.method === 'HEAD' || /head=true/.test(prefer);

    if (req.method === 'GET' || req.method === 'HEAD') {
      let out = applyFilters(rows, url.searchParams);
      const total = out.length;
      const limit = parseInt(url.searchParams.get('limit') || '', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const range = /^(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
      if (range) out = out.slice(parseInt(range[1], 10), parseInt(range[2], 10) + 1);
      else if (Number.isFinite(limit)) out = out.slice(offset, offset + limit);
      const headers = { 'content-type': 'application/json' };
      if (wantCount) headers['content-range'] = (out.length ? '0-' + (out.length - 1) : '*') + '/' + total;
      const wantsObj = /vnd\.pgrst\.object/.test(String(req.headers.accept || ''));
      res.writeHead(200, headers);
      return res.end(isHead ? '' : (wantsObj ? JSON.stringify(out[0] ?? null) : JSON.stringify(out)));
    }
    // .single()/.maybeSingle() ask for a bare object via the Accept header.
    const wantsObject = /vnd\.pgrst\.object/.test(String(req.headers.accept || ''));
    const shape = (list) => (wantsObject ? JSON.stringify(list[0] ?? null) : JSON.stringify(list));
    if (req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : body ? [body] : [];
      const inserted = list.map((r, i) => ({ id: table + '-new-' + (rows.length + i + 1), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }));
      rows.push(...inserted);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(shape(inserted));
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const target = applyFilters(rows, url.searchParams);
      target.forEach((r) => Object.assign(r, body || {}, { updated_at: new Date().toISOString() }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(shape(target));
    }
    if (req.method === 'DELETE') {
      const target = new Set(applyFilters(rows, url.searchParams));
      tables[table] = rows.filter((r) => !target.has(r));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([...target]));
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'mock: no route for ' + req.method + ' ' + url.pathname }));
});

server.listen(54321, '127.0.0.1', () => console.log('mock supabase on http://127.0.0.1:54321'));

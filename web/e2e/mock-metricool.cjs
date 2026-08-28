// A stand-in for app.metricool.com's scheduler API, so the paths that reach a
// real social account can be proven without one.
//
// Point the app at it with METRICOOL_API_BASE=http://127.0.0.1:54322 (both
// lib/metricool.ts and lib/performance.ts honour that variable; production
// never sets it).
//
// Implements the four calls the app makes, records every request for the test
// to inspect, and can be told to reject a PUT so the "fail closed" behaviour of
// rescheduling is exercised rather than assumed.
const http = require('http');

let posts = new Map();   // id -> { id, text, publicationDate, providers, draft, autoPublish }
let log = [];            // every request, in order
let nextId = 1000;
let failNext = { PUT: false, DELETE: false, POST: false };

function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : null); } catch { resolve(null); } });
  });
}
const json = (res, code, payload) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:54322');

  // --- harness introspection ---
  if (url.pathname === '/__requests') return json(res, 200, log);
  if (url.pathname === '/__posts') return json(res, 200, [...posts.values()]);
  if (url.pathname === '/__reset') { posts = new Map(); log = []; failNext = { PUT: false, DELETE: false, POST: false }; return json(res, 200, { ok: true }); }
  if (url.pathname === '/__fail') {
    const method = (url.searchParams.get('method') || 'PUT').toUpperCase();
    failNext[method] = url.searchParams.get('off') !== '1';
    return json(res, 200, { failNext });
  }

  const payload = await body(req);
  log.push({
    method: req.method,
    path: url.pathname,
    blogId: url.searchParams.get('blogId'),
    userId: url.searchParams.get('userId'),
    auth: req.headers['x-mc-auth'] || null,
    body: payload,
  });

  // Every real call is authenticated by this header; refuse without it so a
  // regression that drops it fails loudly here instead of silently upstream.
  if (!req.headers['x-mc-auth']) return json(res, 401, { error: 'missing X-Mc-Auth' });

  const m = /^\/v2\/scheduler\/posts(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'mock metricool: no route for ' + req.method + ' ' + url.pathname });
  const id = m[1];

  if (req.method === 'POST' && !id) {
    if (failNext.POST) return json(res, 500, { error: 'mock: forced POST failure' });
    const post = { id: String(nextId++), ...payload };
    posts.set(post.id, post);
    return json(res, 200, { data: post });
  }
  if (req.method === 'PUT' && id) {
    if (failNext.PUT) return json(res, 500, { error: 'mock: forced PUT failure' });
    if (!posts.has(id)) return json(res, 404, { error: 'not found' });
    // Metricool's update is a REPLACE, and it validates the whole object. A
    // body carrying only the new publicationDate is refused with exactly this
    // shape — reproduced here because the app shipped that bug once and the
    // mock accepted it happily:
    //   400 ValidationError { text: "must not be null",
    //                         providers: "must not be empty" }
    const detail = {};
    if (payload == null || payload.text == null || String(payload.text).trim() === '') detail.text = 'must not be null';
    if (!Array.isArray(payload && payload.providers) || payload.providers.length === 0) detail.providers = 'must not be empty';
    if (Object.keys(detail).length) {
      return json(res, 400, { status: 'BAD_REQUEST', code: '400', title: 'ValidationError', detail });
    }
    posts.set(id, { ...posts.get(id), ...payload });
    return json(res, 200, { data: posts.get(id) });
  }
  if (req.method === 'DELETE' && id) {
    if (failNext.DELETE) return json(res, 500, { error: 'mock: forced DELETE failure' });
    posts.delete(id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'method not allowed' });
});

server.listen(54322, '127.0.0.1', () => console.log('mock metricool on http://127.0.0.1:54322'));

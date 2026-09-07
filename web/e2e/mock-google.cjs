// A stand-in for the Google Sheets + Drive REST endpoints lib/google-sources.ts
// calls, plus Crossref for lib/citation.ts. Seeded with rows shaped like the
// real documents (Meriz's calendar with monthly tabs, Rodrigo's video sheet
// with Spanish headers, Liliana's image folder) so the parsers are exercised
// for real. Requires the bearer token GOOGLE_STATIC_TOKEN=e2e-google-token —
// anything else is 401, as the real APIs would answer.
//
// Point the app here with GOOGLE_API_BASE=http://127.0.0.1:54325 and
// CROSSREF_API_BASE=http://127.0.0.1:54325/crossref.
//
// Introspection: GET /__state returns every tab (including rows appended by
// the app); POST /__reset restores the seed; POST /__unshare {"id"} makes a
// document answer 403 until the next reset.
const http = require('http');

const PORT = 54325;
const TOKEN = 'e2e-google-token';
const CALENDAR = process.env.SOURCES_CALENDAR_SHEET_ID || '16W7b71lBCzTavgq_UP7yXSb5qyHrkqyno1FsTCmo86o';
const VIDEOS = process.env.SOURCES_VIDEOS_SHEET_ID || '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc';
const FOLDER = process.env.SOURCES_IMAGES_FOLDER_ID || '1zQdyCBQ_-b-7IxS2hjrfXsd1tm8Yx9Rq';

const future = (days) => { const d = new Date(Date.now() + days * 86400e3); return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); };

function seed() {
  return {
    [CALENDAR]: {
      tabs: [
        { title: 'Content Calendar', sheetId: 1, rows: [['May 2026', 'Task Delegation'], ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'ID', 'Date', 'Pillar', 'Type', 'Description', 'Owner', 'Status', 'CTA'], ['1', '2', '1'], ['3', '4', '5', '6', '7', '8', '9', '2', '', '', '', '', '', 'Not started']] },
        { title: 'May Content', sheetId: 2, rows: [
          ['Cellular Institute Content Calendar'],
          ['Number of Posts', 'Date', 'Type of Post', 'Caption', 'File Name', 'Graphics Link', 'Status', 'IG', 'FB', 'LinkedIn', 'TikTok', 'X', 'YouTube', 'AVISO DE PUBLICIDAD: 2623022002A00090'],
          ['', 'May 13, 2026', 'DESIGN ', 'Many times, the body starts showing signals before a bigger problem develops.', 'POST JUNIO— 1.jpg', 'https://drive.google.com/file/d/1eBek/view', 'POSTED', 'x', 'x', '', '', '', ''],
          ['', 'May 20, 2026', 'PHOTO', 'Before thinking about any advanced intervention, the body needs a better foundation.\n\nREF: Rogeri, P.S., et al. (2021). Nutrients, 14(1), 52. DOI: 10.3390/nu14010052', 'POST JUNIO— 4.jpg', 'https://drive.google.com/file/d/1ixh/view', 'POSTED', 'x', '', '', '', '', ''],
        ] },
        { title: 'September Content', sheetId: 3, rows: [
          ['Number of Posts', 'Date', 'Type of Post', 'Caption', 'File Name', 'Graphics Link', 'Status', 'IG', 'FB', 'LinkedIn', 'TikTok', 'X', 'YouTube'],
          ['1', future(3), 'DESIGN', 'Exosome therapy: what the evidence says about joint recovery.', 'SEP-1.jpg', 'https://drive.google.com/file/d/1sep1/view', 'For approval', 'x', 'x', '', '', '', ''],
          ['2', future(10), 'PHOTO', 'Meet the team behind your evaluation.', 'SEP-2.jpg', '', 'Not started', 'x', '', 'x', '', '', ''],
        ] },
      ],
    },
    [VIDEOS]: {
      tabs: [
        { title: '2026 CELLULAR HOPE', sheetId: 1, rows: [
          [' ', 'FECHA DE ELABORACIÓN', 'TIPO DE VIDEO', 'TÍTULO DEL VIDEO', 'COPY', 'LINK VIDEO', 'FORMATO', 'YOUTUBE', 'LINKEDIN', 'TIKTOK', 'X', 'FACEBOOK', 'INSTAGRAM', 'EMAIL', 'OBSERVACIÓN', 'TÍTULO THUMBNAILS', 'LINK PORTADA'],
          ['Rodrigo', 'Feb.', 'Your Journey Begins Here', 'How Our Medical Evaluation Process Works | Cellular Institute Cancun', '', 'https://drive.google.com/file/d/1FXHc/view', 'Horizontal 16:9', 'Unlisted', '', '', '', '', '', '', '', "you're in! here's what happens next", 'https://drive.google.com/file/d/1ZHf/view'],
          ['Milán', 'Feb.', 'IV Therapy', 'IV therapy guided by physicians in Cancun within a structured clinical environment.', 'IV therapy guided by physicians in Cancun.', '1. https://drive.google.com/file/d/1Mhg/view 2. https://drive.google.com/file/d/1Hdf/view', 'Vertical 9:16', '', '', 'x', '', 'x', 'x', '', '', '', ''],
        ] },
      ],
    },
  };
}

const IMAGES = [
  { id: '1G3E5mHrn6sPzKdUZhSMIa_QJWcL559Mu', name: 'ALE02947.jpg', mimeType: 'image/jpeg', modifiedTime: '2026-08-07T17:59:26Z', size: '670174' },
  { id: '1yyzd1yM6rZXtB9ojtUGt9uZUU0soWoDp', name: 'ChatGPT Image Aug 28, 2026.png', mimeType: 'image/png', modifiedTime: '2026-08-28T17:24:34Z', size: '1827331' },
  { id: '1laPYikDA8xvFQ58y6bseGxipKjdofzld', name: 'DSC01844.JPG', mimeType: 'image/jpeg', modifiedTime: '2026-04-17T20:41:15Z', size: '3473408' },
];
// A 1x1 PNG so the import path moves real bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let docs = seed();
let unshared = new Set();

async function body(req) { let raw = ''; for await (const c of req) raw += c; try { return raw ? JSON.parse(raw) : null; } catch { return null; } }
function send(res, status, obj, type = 'application/json') { res.writeHead(status, { 'content-type': type }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const p = url.pathname;

  if (p === '/__state') return send(res, 200, docs);
  if (p === '/__reset') { docs = seed(); unshared = new Set(); return send(res, 200, { ok: true }); }
  if (p === '/__unshare') { const b = await body(req); if (b?.id) unshared.add(b.id); return send(res, 200, { ok: true }); }

  // Crossref stand-in (no auth).
  if (p.startsWith('/crossref/works/')) {
    const doi = decodeURIComponent(p.slice('/crossref/works/'.length));
    if (/^10\.3390\//.test(doi)) return send(res, 200, { message: { title: ['A real Nutrients paper'], issued: { 'date-parts': [[2021, 7, 15]] } } });
    return send(res, 404, 'Resource not found.', 'text/plain');
  }

  if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });

  // --- Sheets ---
  let m;
  if ((m = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(p))) {
    const id = decodeURIComponent(m[1]);
    if (unshared.has(id) || !docs[id]) return send(res, unshared.has(id) ? 403 : 404, { error: { code: 403, message: 'The caller does not have permission' } });
    return send(res, 200, { sheets: docs[id].tabs.map((t, i) => ({ properties: { title: t.title, sheetId: t.sheetId, index: i } })) });
  }
  if ((m = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(p)) && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    if (!docs[id] || unshared.has(id)) return send(res, 403, { error: { code: 403 } });
    const b = await body(req);
    for (const r of b?.requests || []) if (r.addSheet) docs[id].tabs.push({ title: r.addSheet.properties.title, sheetId: 100 + docs[id].tabs.length, rows: [] });
    return send(res, 200, { replies: [] });
  }
  if ((m = /^\/v4\/spreadsheets\/([^/]+)\/values\/([^/:]+)(:append)?$/.exec(p))) {
    const id = decodeURIComponent(m[1]);
    const range = decodeURIComponent(m[2]);
    const tabName = range.replace(/^'/, '').replace(/'(![A-Z0-9:]+)?$/, '').replace(/''/g, "'");
    if (!docs[id] || unshared.has(id)) return send(res, 403, { error: { code: 403 } });
    const tab = docs[id].tabs.find((t) => t.title === tabName);
    if (!tab) return send(res, 400, { error: { code: 400, message: 'Unable to parse range: ' + range } });
    if (m[3] && req.method === 'POST') {
      const b = await body(req);
      for (const row of b?.values || []) tab.rows.push(row.map(String));
      return send(res, 200, { updates: { updatedRows: (b?.values || []).length } });
    }
    return send(res, 200, { range, majorDimension: 'ROWS', values: tab.rows });
  }

  // --- Drive ---
  if (p === '/drive/v3/files' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    if (unshared.has(FOLDER) || !q.includes(FOLDER)) return send(res, 200, { files: [] });
    return send(res, 200, { files: IMAGES });
  }
  if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
    const id = decodeURIComponent(m[1]);
    const f = IMAGES.find((x) => x.id === id);
    if (!f) return send(res, 404, { error: { code: 404, message: 'File not found' } });
    if (url.searchParams.get('alt') === 'media') return send(res, 200, PNG, f.mimeType);
    return send(res, 200, f);
  }
  send(res, 404, { error: { code: 404, message: 'mock: no route for ' + req.method + ' ' + p } });
});

server.listen(PORT, '127.0.0.1', () => console.log('mock google on http://127.0.0.1:' + PORT));

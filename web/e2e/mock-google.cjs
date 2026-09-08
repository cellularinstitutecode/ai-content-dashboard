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
        // Meriz's real layout: a month grid down columns A-G, a BLANK spacer in
        // H, and the task table from I onward — ID · Date · Pillar · Type ·
        // Description · Owner · Status · CTA. There is no "Caption" column and
        // no "Graphics Link"; the post text lives in Description. An earlier
        // fixture invented those names, so the reader passed its tests and
        // still returned nothing at all from the real sheet.
        { title: 'Content Calendar', sheetId: 1, rows: [
          ['Cellular Institute Social Media Calendar'],
          [],
          ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', '', 'ID', 'Date', 'Pillar', 'Type', 'Description', 'Owner', 'Status', 'CTA'],
          ['', '', '', '', '', '1', '2', '', '1', future(3), 'Education', 'Reel', 'Exosome therapy: what the evidence says about joint recovery.', 'Meriz', 'For approval', 'Book a call'],
          ['3', '4', '5', '6', '7', '8', '9', '', '2', future(10), 'Proof', 'Carousel', 'Meet the team behind your evaluation.', 'Meriz', 'Not started', ''],
          ['10', '11', '12', '13', '14', '15', '16', '', '3', '', '', '', '', '', '', ''],
        ] },
        // A tab with a Date column and no post text is a planning skeleton, not
        // posts. The reader must skip it or the "coming up" list fills with
        // blank rows.
        { title: 'Task Delegation', sheetId: 9, rows: [
          ['Owner', 'Date', 'Status'],
          ['Meriz', '2026-09-01', 'Ongoing'],
        ] },
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
          // These two rows are copied cell-for-cell from the real sheet, TIPO DE
          // VIDEO blank and all. An earlier fixture omitted that column, which
          // shifted every value one place left: the copy showed up as the
          // title, and 'Unlisted' (an OBSERVACIÓN) landed in YOUTUBE and was
          // read as a network. The flags really are Google's TRUE/FALSE
          // checkboxes, so FALSE has to be here or nothing tests that FALSE
          // means no. The first row's YOUTUBE cell holds the published link
          // instead of TRUE — the sheet does that too once a video is up — so
          // it must still read as "on YouTube" AND offer Prepare.
          ['Rodrigo', 'Feb.', '', 'Your Journey Begins Here', 'How Our Medical Evaluation Process Works | Cellular Institute Cancun', 'https://drive.google.com/file/d/1FXHc/view', 'Horizontal 16:9', 'https://www.youtube.com/watch?v=capt0000001', 'FALSE', '', '', '', '', 'FALSE', 'Unlisted', "you're in! here's what happens next", 'https://drive.google.com/file/d/1ZHf/view'],
          ['Milán', 'Feb.', '', 'IV Therapy', 'IV therapy guided by physicians in Cancun within a structured clinical environment.', '1. https://drive.google.com/file/d/1Mhg/view 2. https://drive.google.com/file/d/1Hdf/view', 'Vertical 9:16', 'TRUE', 'FALSE', 'TRUE', 'FALSE', 'TRUE', 'TRUE', 'FALSE', '', '', ''],
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
let anthropicFailNext = 0; // POST /__anthropic_fail {"n"}: the next n writer calls answer 500

async function body(req) { let raw = ''; for await (const c of req) raw += c; try { return raw ? JSON.parse(raw) : null; } catch { return null; } }
function send(res, status, obj, type = 'application/json') { res.writeHead(status, { 'content-type': type }); res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); }

// Make Google refuse the way Google really refuses. POST /__refuse
// {"status":403,"body":"..."} and the next Sheets/Drive read fails with that
// exact payload; {"status":null} clears it. Nothing else can exercise the
// difference between "not shared", "API not enabled" and "bad scopes", which
// need three different actions from three different people.
let refuse = null;

/** 'A' -> 0, 'Z' -> 25, 'AA' -> 26. */
let uploadSeq = 0;
// A pristine copy of the fixture so a suite can put the documents back exactly
// as it found them — the API suite now EDITS these sheets, and the browser
// suite that runs after it must not inherit those edits.
const SEED = JSON.stringify({ docs, IMAGES });

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (url.pathname === '/__refuse') {
    const chunks = []; for await (const c of req) chunks.push(c);
    let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    refuse = b && b.status ? { status: Number(b.status), body: String(b.body || '{}') } : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ refuse }));
  }
  if (refuse && (url.pathname.startsWith('/v4/') || url.pathname.startsWith('/drive/'))) {
    res.writeHead(refuse.status, { 'content-type': 'application/json' });
    return res.end(refuse.body);
  }
  const p = url.pathname;

  if (p === '/__state') return send(res, 200, docs);
  if (p === '/__reset') { docs = seed(); unshared = new Set(); anthropicFailNext = 0; return send(res, 200, { ok: true }); }
  if (p === '/__anthropic_fail') { const b = await body(req); anthropicFailNext = Number(b?.n || 0); return send(res, 200, { ok: true }); }
  if (p === '/__unshare') { const b = await body(req); if (b?.id) unshared.add(b.id); return send(res, 200, { ok: true }); }

  // YouTube stand-in (no auth): YOUTUBE_BASE=http://127.0.0.1:54325/yt
  // /yt/watch?v=capt0000001 has an uploaded English track; v=auto0000001 only an
  // auto-generated one; v=nocap000001 none; anything else is a 404 page.
  if (p === '/yt/watch') {
    const v = url.searchParams.get('v') || '';
    const head = (title) => '<html><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"' + v + '","title":"' + title + '","lengthSeconds":"93"},';
    if (v === 'capt0000001') return send(res, 200, head('Stem cells and knee pain: what the evidence says') + '"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"http://127.0.0.1:54325/yt/api/timedtext?v=capt0000001\\u0026lang=en","languageCode":"en","name":{"simpleText":"English"}}]}}};</script></html>', 'text/html');
    if (v === 'auto0000001') return send(res, 200, head('Auto captions only') + '"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"http://127.0.0.1:54325/yt/api/timedtext?v=auto0000001\\u0026lang=es","languageCode":"es","kind":"asr","name":{"simpleText":"Spanish (auto-generated)"}}]}}};</script></html>', 'text/html');
    if (v === 'nocap000001') return send(res, 200, head('A video without captions') + '"playabilityStatus":{"status":"OK"}};</script></html>', 'text/html');
    return send(res, 404, '<html>not found</html>', 'text/html');
  }
  if (p === '/yt/api/timedtext') {
    const v = url.searchParams.get('v') || '';
    const lines = v === 'auto0000001'
      ? ['hola y bienvenidos a la clínica', 'hoy hablamos de terapia celular para rodilla', 'consulta siempre con tu médico antes de decidir']
      : ['Welcome to Cellular Institute.', 'Today we look at what published studies say about stem cell therapy for knee osteoarthritis,', 'including a 2021 review that found improvements in pain scores at twelve months.', 'Always talk to your doctor before choosing a treatment.'];
    return send(res, 200, { events: lines.map((t, i) => ({ tStartMs: i * 3000, dDurationMs: 2900, segs: [{ utf8: t }] })) });
  }

  // Anthropic stand-in (no auth check): ANTHROPIC_API_BASE=http://127.0.0.1:54325/anthropic
  // Returns a compliant social pack whose REF line carries a DOI Crossref
  // (above) knows, so the whole write → cite → AVISO path runs offline.
  if (p === '/anthropic/v1/messages' && req.method === 'POST') {
    const b = await body(req);
    if (anthropicFailNext > 0) { anthropicFailNext--; return send(res, 500, { type: 'error', error: { type: 'api_error', message: 'mock: writer down' } }); }
    const user = String(b?.messages?.[0]?.content || '');
    const fromVideo = /TRANSCRIPT:/.test(user);
    const ref = 'REF: Rogeri PS et al. (2021) Nutrients 14(1):52. DOI: 10.3390/nu14010052';
    const pack = {
      instagram: (fromVideo ? 'New video: what the evidence says about stem cell therapy for knee pain. ' : 'Mock Instagram caption. ') + '#stemcells #kneepain\n' + ref,
      facebook: (fromVideo ? 'We sat down to go through the published studies on knee osteoarthritis and cell therapy. ' : 'Mock Facebook post. ') + ref,
      linkedin: (fromVideo ? 'In our latest video we walk through what peer-reviewed studies report on stem cell therapy for knee osteoarthritis — including pain-score improvements at twelve months — and why the conversation always starts with your doctor.' : 'Mock LinkedIn post.') + '\n' + ref,
      blog: '',
    };
    return send(res, 200, { id: 'msg_mock', type: 'message', role: 'assistant', model: b?.model || 'mock', content: [{ type: 'text', text: JSON.stringify(pack) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
  }

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
  if (url.pathname === '/__reseed') {
    const fresh = JSON.parse(SEED);
    for (const k of Object.keys(docs)) delete docs[k];
    Object.assign(docs, fresh.docs);
    IMAGES.length = 0;
    IMAGES.push(...fresh.IMAGES);
    refuse = null;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  // Multipart upload into the folder, the way "Add a photo" does it.
  if (p === '/upload/drive/v3/files' && req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const meta = /\{[^}]*"name"[^}]*\}/.exec(raw.toString('utf8', 0, Math.min(raw.length, 2000)));
    let name = 'upload.jpg', parents = [];
    try { const j = JSON.parse(meta ? meta[0] : '{}'); name = j.name || name; parents = j.parents || []; } catch {}
    const id = 'uploaded-' + (++uploadSeq);
    const file = { id, name, mimeType: 'image/jpeg', size: String(raw.length), modifiedTime: new Date().toISOString(), parents };
    IMAGES.unshift(file);
    return send(res, 200, file);
  }
  // Writing single cells, the way the dashboard edits a row.
  if ((m = /^\/v4\/spreadsheets\/([^/]+)\/values:batchUpdate$/.exec(p)) && req.method === 'POST') {
    const doc = docs[m[1]];
    if (!doc) return send(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: 'No such spreadsheet' } });
    const b = await body(req);
    let updated = 0;
    for (const d of b?.data || []) {
      const cell = /^'?([^'!]+)'?!([A-Z]+)(\d+)$/.exec(String(d.range || ''));
      if (!cell) continue;
      const tab = doc.tabs.find((t) => t.title === cell[1]);
      if (!tab) return send(res, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unable to parse range: ' + d.range } });
      const col = colIndex(cell[2]);
      const row = Number(cell[3]) - 1;
      while (tab.rows.length <= row) tab.rows.push([]);
      const r = tab.rows[row];
      while (r.length <= col) r.push('');
      r[col] = String(d.values?.[0]?.[0] ?? '');
      updated++;
    }
    return send(res, 200, { totalUpdatedCells: updated });
  }
  // Reading named cells back, for the "did anyone change this underneath us" check.
  if ((m = /^\/v4\/spreadsheets\/([^/]+)\/values:batchGet$/.exec(p))) {
    const doc = docs[m[1]];
    if (!doc) return send(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: 'No such spreadsheet' } });
    const ranges = url.searchParams.getAll('ranges');
    const valueRanges = ranges.map((rg) => {
      const cell = /^'?([^'!]+)'?!([A-Z]+)(\d+)$/.exec(rg);
      if (!cell) return { range: rg };
      const tab = doc.tabs.find((t) => t.title === cell[1]);
      const v = tab && tab.rows[Number(cell[3]) - 1] ? tab.rows[Number(cell[3]) - 1][colIndex(cell[2])] : undefined;
      return v === undefined || v === '' ? { range: rg } : { range: rg, values: [[String(v)]] };
    });
    return send(res, 200, { valueRanges });
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

// web/lib/google-sources.ts
// The three Google documents the team plans in, read (and one of them written)
// from the dashboard:
//
//   calendar  Meriz's "Cellular Institute Social Media Calendar" sheet — one
//             tab per month, one row per post (date, caption, graphic link,
//             status, which networks).
//   videos    Rodrigo's "Distribución RRSS CHI" sheet — the video inventory
//             (title, copy, Drive link, format, which networks, thumbnails).
//   images    The team's Drive folder of photos and renders.
//
// Auth is the service account the app already uses for clip storage
// (GOOGLE_SERVICE_ACCOUNT_JSON); share the two sheets and the folder with its
// email as Editor and everything here works. The Google REST APIs are called
// with plain fetch so the whole module can run against a local stand-in
// (GOOGLE_API_BASE + GOOGLE_STATIC_TOKEN) in the e2e harness — nothing
// here is reachable from a test otherwise.
//
// Reading is tolerant of the sheets' real, human-edited shape: header rows
// are found by content, not position; columns are matched by name in either
// language; missing cells are missing, not errors.
import 'server-only';
import { randomUUID } from 'crypto';

import { google } from 'googleapis';
import { reportError } from '@/lib/report';
import { classifyGoogleError, type GoogleFailure } from './google-error.ts';

export { classifyGoogleError, type GoogleFailure };
import { parseSheetDate, pick, tableFromRows, columnFor, columnLetter } from '@/lib/sheet-table';

// The clinic's documents. Overridable per environment, never secret.
export const SOURCE_IDS = {
  calendarSheet: () => process.env.SOURCES_CALENDAR_SHEET_ID || '16W7b71lBCzTavgq_UP7yXSb5qyHrkqyno1FsTCmo86o',
  videosSheet: () => process.env.SOURCES_VIDEOS_SHEET_ID || '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc',
  imagesFolder: () => process.env.SOURCES_IMAGES_FOLDER_ID || '1zQdyCBQ_-b-7IxS2hjrfXsd1tm8Yx9Rq',
};

export const APPROVALS_TAB = 'Dashboard Approvals';
export const APPROVALS_HEADER = ['Approved at', 'Publish date', 'Networks', 'Caption', 'Media link', 'Source', 'Dashboard post id'];

const SHEETS_BASE = () => (process.env.GOOGLE_API_BASE || 'https://sheets.googleapis.com').replace(/\/$/, '');
const DRIVE_BASE = () => (process.env.GOOGLE_API_BASE ? process.env.GOOGLE_API_BASE.replace(/\/$/, '') : 'https://www.googleapis.com');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function sourcesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) || Boolean(process.env.GOOGLE_STATIC_TOKEN);
}

/** The service account's email — the address to share the documents with. */
export function serviceAccountEmail(): string | null {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    return String(JSON.parse(raw).client_email || '') || null;
  } catch {
    return null;
  }
}

let tokenCache: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (process.env.GOOGLE_STATIC_TOKEN) return process.env.GOOGLE_STATIC_TOKEN;
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.value;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  const creds = JSON.parse(raw);
  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    // drive.file, not the full drive scope: it grants access only to files
    // this app itself created or that were explicitly opened to it, so a bug
    // here cannot reach the rest of the Drive — including the clip-storage
    // folder lib/drive.ts owns, which mints its own token anyway. Paired with
    // drive.readonly because the Image Library also LISTS and DOWNLOADS photos
    // the team put there, which drive.file alone would not see.
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
  const t = await jwt.getAccessToken();
  const value = typeof t === 'string' ? t : String(t?.token || '');
  if (!value) throw new Error('google: no access token');
  tokenCache = { value, exp: Date.now() + 50 * 60_000 };
  return value;
}

async function gfetch(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  const token = await accessToken();
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), authorization: 'Bearer ' + token },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(to);
  }
}

export class GoogleSourceError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Google's own machine reason, e.g. 'accessNotConfigured' or 'permissionDenied'. */
    public reason: GoogleFailure = 'unknown',
    /** Google's own sentence, kept so a person can read what Google actually said. */
    public detail: string = '',
  ) {
    super(message);
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    // Read the body. Google says exactly which of several very different
    // problems this is, and throwing that away is what left the dashboard
    // guessing out loud.
    const body = await res.text().catch(() => '');
    const { reason, detail } = classifyGoogleError(res.status, body);
    throw new GoogleSourceError(res.status, what + ' failed: HTTP ' + res.status, reason, detail);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

type SheetMeta = { title: string; sheetId: number; index: number; columnCount: number };

export async function listTabs(spreadsheetId: string): Promise<SheetMeta[]> {
  const res = await gfetch(SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '?fields=sheets.properties');
  const j = await json<{ sheets?: { properties: { title: string; sheetId: number; index: number; gridProperties?: { columnCount?: number } } }[] }>(res, 'sheet metadata');
  return (j.sheets || []).map((s) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
    index: s.properties.index,
    // A tab is 26 columns wide by default. Writing past the grid is an error,
    // not an auto-expand, so a caller adding a column has to know this.
    columnCount: s.properties.gridProperties?.columnCount ?? 26,
  }));
}

export async function readTab(spreadsheetId: string, tab: string): Promise<string[][]> {
  const range = encodeURIComponent("'" + tab.replace(/'/g, "''") + "'");
  const res = await gfetch(SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/' + range + '?majorDimension=ROWS');
  const j = await json<{ values?: string[][] }>(res, 'sheet read');
  return j.values || [];
}

/**
 * The columns this app is willing to touch on a calendar row, as
 * field → A1 letter. The month grid on the left of every tab (Sun…Sat) is
 * deliberately absent: those cells are Meriz's layout, not data, and a write
 * that landed in one would corrupt the calendar's appearance silently.
 */
export const CALENDAR_EDITABLE = ['description', 'date', 'status', 'owner', 'pillar', 'type', 'cta'] as const;
export type CalendarField = (typeof CALENDAR_EDITABLE)[number];

const CALENDAR_WANTED = [
  'date', 'description', 'status', 'owner', 'pillar', 'type', 'cta', 'id',
  // Older/other layouts this reader has met.
  'caption', 'type of post', 'graphics link', 'file name',
];

function calendarColumns(header: string[]): Partial<Record<CalendarField, string>> {
  const out: Partial<Record<CalendarField, string>> = {};
  const at = (f: CalendarField, ...names: string[]) => {
    const c = columnFor(header, ...names);
    if (c) out[f] = c;
  };
  at('description', 'description', 'caption', 'copy');
  at('date', 'date', 'fecha');
  at('status', 'status', 'estatus', 'estado');
  at('owner', 'owner', 'responsable');
  at('pillar', 'pillar', 'pilar');
  at('type', 'type of post', 'type', 'tipo');
  at('cta', 'cta', 'call to action');
  return out;
}

export type CalendarEntry = {
  tab: string;
  /** 1-based row in that tab, so the row can be edited. */
  row: number;
  headerRow: number;
  /** Which A1 column each editable field lives in, on this tab. */
  columns: Partial<Record<CalendarField, string>>;
  pillar: string;
  owner: string;
  cta: string;
  date: string | null;
  type: string;
  caption: string;
  fileName: string;
  graphicsLink: string;
  status: string;
  networks: string[];
};

const NETWORK_COLUMNS: [string, string][] = [['ig', 'instagram'], ['fb', 'facebook'], ['linkedin', 'linkedin'], ['tiktok', 'tiktok'], ['x', 'twitter'], ['youtube', 'youtube']];

/** Every planned post across the monthly tabs, newest first. */
export async function readCalendar(spreadsheetId = SOURCE_IDS.calendarSheet()): Promise<{ entries: CalendarEntry[]; tabs: string[] }> {
  const tabs = await listTabs(spreadsheetId);
  const contentTabs = tabs.filter((t) => /content|calendar|posts|contenido/i.test(t.title) && !/reference|legend|delegation/i.test(t.title));
  const chosen = (contentTabs.length ? contentTabs : tabs).filter((t) => t.title !== APPROVALS_TAB);
  const entries: CalendarEntry[] = [];
  const used: string[] = [];
  for (const t of chosen) {
    let rows: string[][] = [];
    try { rows = await readTab(spreadsheetId, t.title); } catch (e) { reportError('sources:calendar-tab', e, { tab: t.title }); continue; }
    // The real sheet's task table is headed ID · Date · Pillar · Type ·
    // Description · Owner · Status · CTA — there is no "Caption", no "Graphics
    // Link" and no "File Name". Asking only for those three meant two matches
    // against a threshold of three, so the reader abandoned every tab and the
    // calendar came back empty however good the access was. The post text
    // lives in Description.
    const { header, headerRow, records } = tableFromRows(rows, CALENDAR_WANTED);
    // A tab with dates but nothing written in them is a planning grid, not
    // posts. Description (or Caption, on older layouts) is what makes it real.
    const textCol = columnFor(header, 'description', 'caption', 'copy');
    if (!textCol) continue;
    used.push(t.title);
    for (const { rec: r, row } of records) {
      const caption = pick(r, 'description', 'caption', 'copy');
      const date = parseSheetDate(pick(r, 'date', 'fecha'));
      if (!caption && !date) continue;
      const networks = NETWORK_COLUMNS.filter(([col]) => YES.test(pick(r, col))).map(([, n]) => n);
      entries.push({
        tab: t.title,
        row,
        headerRow,
        columns: calendarColumns(header),
        date,
        type: pick(r, 'type of post', 'type', 'tipo'),
        pillar: pick(r, 'pillar', 'pilar'),
        owner: pick(r, 'owner', 'responsable'),
        cta: pick(r, 'cta', 'call to action'),
        caption,
        fileName: pick(r, 'file name', 'archivo'),
        graphicsLink: pick(r, 'graphics link', 'graphic', 'link'),
        status: pick(r, 'status', 'estatus', 'estado'),
        networks,
      });
    }
  }
  entries.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { entries, tabs: used };
}

/**
 * The columns this app may write on a video row.
 *
 * `keywords`, `ref` and `aiStatus` are the three the automatic sweep adds
 * (lib/video-autopilot.ts) and are the reason the sheet needs three new
 * headers; every other field here predates it. The network checkbox columns
 * are writable by a person editing a row in the dashboard — the sweep never
 * touches them, because ticking one is a publishing decision.
 */
export const VIDEO_EDITABLE = ['title', 'copy', 'format', 'type', 'notes',
  'keywords', 'ref', 'aiStatus',
  'youtube', 'linkedin', 'tiktok', 'x', 'facebook', 'instagram', 'email'] as const;
export type VideoField = (typeof VIDEO_EDITABLE)[number];

/** The headers the sweep writes into, in the order they should be appended to a tab. */
export const AI_COLUMNS: { field: VideoField; header: string }[] = [
  { field: 'keywords', header: 'KEYWORDS' },
  { field: 'ref', header: 'REF' },
  { field: 'aiStatus', header: 'ESTADO IA' },
];

function videoColumns(header: string[]): Partial<Record<VideoField, string>> {
  const out: Partial<Record<VideoField, string>> = {};
  const at = (f: VideoField, ...names: string[]) => {
    const c = columnFor(header, ...names);
    if (c) out[f] = c;
  };
  at('title', 'título del video', 'titulo del video', 'title');
  at('copy', 'copy', 'caption');
  at('format', 'formato', 'format');
  at('type', 'tipo de video', 'tipo', 'type');
  at('notes', 'observación', 'observacion', 'notes');
  at('keywords', 'keywords', 'palabras clave');
  at('ref', 'ref', 'referencia', 'reference');
  at('aiStatus', 'estado ia', 'ai status', 'estatus ia');
  for (const [col] of VIDEO_NETWORKS) at(col as VideoField, col);
  return out;
}

export type VideoEntry = {
  tab: string;
  row: number;
  headerRow: number;
  columns: Partial<Record<VideoField, string>>;
  creator: string;
  month: string;
  type: string;
  title: string;
  copy: string;
  videoLink: string;
  /** The published YouTube URL, when the YOUTUBE column holds one (it may just say "Unlisted"). */
  youtubeLink: string;
  format: string;
  networks: string[];
  thumbnailTitle: string;
  coverLink: string;
  notes: string;
  /** The keyword brief the sweep wrote, when this tab has the column. */
  keywords: string;
  /** The REF citation the sweep wrote. */
  ref: string;
  /** What the sweep last did with this row: 'ready', 'needs transcript', an error. */
  aiStatus: string;
};

/** What counts as "yes" in a hand-kept sheet column: ticks, x, TRUE — never FALSE. */
const YES = /^(x|✓|✔|yes|si|sí|true|posted|done)$/i;
/**
 * A network column can also hold the published link itself (Rodrigo pastes
 * the YouTube URL into YOUTUBE once a video is up). A link there is the
 * strongest "yes" the sheet can give, so it counts — FALSE still does not.
 */
const isTicked = (v: string) => YES.test(v) || /^https?:\/\//i.test(v.trim());

const VIDEO_NETWORKS: [string, string][] = [['youtube', 'youtube'], ['linkedin', 'linkedin'], ['tiktok', 'tiktok'], ['x', 'twitter'], ['facebook', 'facebook'], ['instagram', 'instagram'], ['email', 'email']];

/** The video inventory across every year tab. */
export async function readVideos(spreadsheetId = SOURCE_IDS.videosSheet()): Promise<{ entries: VideoEntry[]; tabs: string[] }> {
  const tabs = (await listTabs(spreadsheetId)).filter((t) => t.title !== APPROVALS_TAB);
  const entries: VideoEntry[] = [];
  for (const t of tabs) {
    let rows: string[][] = [];
    try { rows = await readTab(spreadsheetId, t.title); } catch (e) { reportError('sources:videos-tab', e, { tab: t.title }); continue; }
    const { header, headerRow, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
    if (!header.length) continue;
    // The first column carries the creator's name and has no header.
    const firstKey = header[0] || 'col0';
    const columns = videoColumns(header);
    for (const { rec: r, row } of records) {
      const title = pick(r, 'título del video', 'titulo del video', 'title');
      const videoLink = pick(r, 'link video', 'link', 'video link');
      if (!title && !videoLink) continue;
      // The same strict allowlist the calendar above uses. Any-non-empty is
      // wrong here: Rodrigo's sheet fills these columns with TRUE *and FALSE*
      // (Google's checkbox default), so treating a value as a yes marked every
      // FALSE column as a network the video ships to — a video the sheet says
      // is YouTube-only was listed as LinkedIn and Email as well.
      const networks = VIDEO_NETWORKS.filter(([col]) => isTicked(pick(r, col))).map(([, n]) => n);
      entries.push({
        tab: t.title,
        row,
        headerRow,
        columns,
        creator: firstKey ? r[firstKey] || '' : '',
        month: pick(r, 'fecha de elaboración', 'fecha', 'month'),
        type: pick(r, 'tipo de video', 'tipo', 'type'),
        title,
        copy: pick(r, 'copy', 'caption'),
        videoLink,
        youtubeLink: (String(pick(r, 'youtube')).match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/i) || [''])[0],
        format: pick(r, 'formato', 'format'),
        networks,
        thumbnailTitle: pick(r, 'título thumbnails', 'titulo thumbnails', 'thumbnail'),
        coverLink: pick(r, 'link portada', 'cover'),
        notes: pick(r, 'observación', 'observacion', 'notes'),
        keywords: pick(r, 'keywords', 'palabras clave'),
        ref: pick(r, 'ref', 'referencia', 'reference'),
        aiStatus: pick(r, 'estado ia', 'ai status', 'estatus ia'),
      });
    }
  }
  return { entries, tabs: tabs.map((t) => t.title) };
}

/**
 * Append one approved post to the calendar sheet, on its own tab so nothing
 * Meriz laid out by hand is touched. The tab is created on first use.
 */
/**
 * Write single cells on one row of one tab.
 *
 * Deliberately narrow. It takes explicit A1 column letters — never a field
 * name it resolves itself — because the caller has already checked those
 * columns against an allowlist, and the month grid that sits to the left of
 * the task table on every calendar tab must never be reachable from here. It
 * writes one row at a time so a bug cannot run down the sheet.
 */
export async function updateRowCells(
  spreadsheetId: string,
  tab: string,
  row: number,
  cells: { column: string; value: string }[],
  /** Only ensureAiColumns passes this, to write a NEW header into the header row. */
  opts: { allowHeaderRow?: boolean } = {},
): Promise<void> {
  const floor = opts.allowHeaderRow ? 1 : 2;
  if (!Number.isInteger(row) || row < floor) throw new GoogleSourceError(400, 'refusing to write to row ' + row, 'unknown', 'Row 1 is the header.');
  if (!cells.length) return;
  for (const c of cells) {
    if (!/^[A-Z]{1,3}$/.test(c.column)) throw new GoogleSourceError(400, 'bad column ' + c.column, 'unknown', 'Not an A1 column.');
  }
  const data = cells.map((c) => ({
    range: "'" + tab.replace(/'/g, "''") + "'!" + c.column + row,
    values: [[c.value]],
  }));
  const res = await gfetch(
    SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values:batchUpdate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    },
  );
  await json(res, 'update row');
}

/** The current values of named columns on one row — for checking nothing moved underneath us. */
export async function readRowCells(
  spreadsheetId: string,
  tab: string,
  row: number,
  columns: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!columns.length) return out;
  const ranges = columns.map((c) => "ranges=" + encodeURIComponent("'" + tab.replace(/'/g, "''") + "'!" + c + row)).join('&');
  const res = await gfetch(
    SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values:batchGet?' + ranges,
  );
  const body = await json<{ valueRanges?: { values?: string[][] }[] }>(res, 'read row');
  (body.valueRanges || []).forEach((vr, i) => {
    out[columns[i]] = String(vr?.values?.[0]?.[0] ?? '').trim();
  });
  return out;
}

/**
 * Add a new row to a tab, placing each value in the column its field occupies.
 *
 * Appends after the last row that has anything in it, so a new post lands at
 * the bottom of the task table rather than in the middle of somebody's month
 * grid. Fields the tab has no column for are dropped rather than guessed at.
 */
export async function appendRow(
  spreadsheetId: string,
  tab: string,
  columns: Record<string, string | undefined>,
  values: Record<string, string>,
): Promise<{ row: number }> {
  const placed: { column: string; value: string }[] = [];
  for (const [field, value] of Object.entries(values)) {
    const col = columns[field];
    if (col) placed.push({ column: col, value: String(value ?? '') });
  }
  if (!placed.length) throw new GoogleSourceError(400, 'nothing to write', 'unknown', 'None of those fields exist on this tab.');
  const existing = await readTab(spreadsheetId, tab);
  let last = 0;
  existing.forEach((r, i) => { if (r && r.some((c) => String(c || '').trim())) last = i + 1; });
  const row = last + 1;
  await updateRowCells(spreadsheetId, tab, row, placed);
  return { row };
}

/**
 * Make sure a tab has the three columns the sweep writes into, adding any that
 * are missing to the RIGHT of everything already there.
 *
 * Appended, never inserted. An insert shifts every column after it, and the
 * columns after these are Rodrigo's network checkboxes — the ones a person
 * reads down at a glance to see where a video has gone. Nothing already in the
 * sheet moves, and a tab that already has the headers is left completely alone.
 *
 * Returns the A1 letter for each field, including the ones that already existed.
 */
export async function ensureAiColumns(
  spreadsheetId: string,
  tab: string,
  headerRow: number,
  header: string[],
  /** The widest row on the tab. A column can hold data without having a header. */
  usedWidth = header.length,
): Promise<Partial<Record<VideoField, string>>> {
  const found: Partial<Record<VideoField, string>> = {};
  const missing: { field: VideoField; header: string }[] = [];
  for (const { field, header: name } of AI_COLUMNS) {
    const at = videoColumns(header)[field];
    if (at) found[field] = at;
    else missing.push({ field, header: name });
  }
  if (!missing.length) return found;

  // The first free column: past the header's own width, and past anything
  // further right that a row below happens to use.
  const width = Math.max(header.length, usedWidth);
  const need = width + missing.length;
  const meta = (await listTabs(spreadsheetId)).find((t) => t.title === tab);
  if (meta && meta.columnCount < need) {
    const res = await gfetch(SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + ':batchUpdate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{ appendDimension: { sheetId: meta.sheetId, dimension: 'COLUMNS', length: need - meta.columnCount } }],
      }),
    });
    await json(res, 'widen tab');
  }

  const cells = missing.map((m, i) => ({ column: columnLetter(width + i), value: m.header }));
  await updateRowCells(spreadsheetId, tab, headerRow, cells, { allowHeaderRow: true });
  missing.forEach((m, i) => { found[m.field] = columnLetter(width + i); });
  return found;
}

export async function appendApproval(
  row: { approvedAt: string; publishDate: string; networks: string[]; caption: string; mediaUrl: string; source: string; postId: string },
  spreadsheetId = SOURCE_IDS.calendarSheet()
): Promise<{ tab: string }> {
  const tabs = await listTabs(spreadsheetId);
  if (!tabs.some((t) => t.title === APPROVALS_TAB)) {
    const res = await gfetch(SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + ':batchUpdate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: APPROVALS_TAB } } }] }),
    });
    await json(res, 'create approvals tab');
    const head = await gfetch(
      SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent("'" + APPROVALS_TAB + "'!A1") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: [APPROVALS_HEADER] }) }
    );
    await json(head, 'write approvals header');
  }
  const res = await gfetch(
    SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent("'" + APPROVALS_TAB + "'!A1") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [[row.approvedAt, row.publishDate, row.networks.join(', '), row.caption, row.mediaUrl, row.source, row.postId]] }),
    }
  );
  await json(res, 'append approval');
  return { tab: APPROVALS_TAB };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export type DriveImage = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  /** Opens the file in Drive (needs the viewer to have access). */
  viewUrl: string;
  /** A thumbnail the signed-in browser can load directly. */
  thumbUrl: string;
};

export async function listFolderImages(folderId = SOURCE_IDS.imagesFolder(), limit = 200): Promise<DriveImage[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
  const fields = encodeURIComponent('nextPageToken, files(id, name, mimeType, modifiedTime, size)');
  const out: DriveImage[] = [];
  let pageToken = '';
  while (out.length < limit) {
    const url = DRIVE_BASE() + '/drive/v3/files?q=' + q + '&fields=' + fields + '&pageSize=100&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await gfetch(url);
    const j = await json<{ nextPageToken?: string; files?: { id: string; name: string; mimeType: string; modifiedTime: string; size?: string }[] }>(res, 'folder listing');
    for (const f of j.files || []) {
      out.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        size: f.size ? Number(f.size) : null,
        viewUrl: 'https://drive.google.com/file/d/' + f.id + '/view',
        thumbUrl: 'https://drive.google.com/thumbnail?id=' + f.id + '&sz=w480',
      });
      if (out.length >= limit) break;
    }
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

/** Download one Drive file's bytes (for copying an image into the app's own public storage). */
/**
 * Put a photo into the team's image folder.
 *
 * Upload only. There is no rename and no delete here on purpose: adding a file
 * is recoverable by deleting it in Drive, and the reverse is not. Multipart
 * because Drive wants the metadata and the bytes in one request.
 */
export async function uploadFolderImage(
  bytes: Buffer,
  contentType: string,
  name: string,
  folderId = SOURCE_IDS.imagesFolder(),
): Promise<DriveImage> {
  const boundary = 'chi' + randomUUID().replace(/-/g, '');
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n'),
    Buffer.from('--' + boundary + '\r\nContent-Type: ' + contentType + '\r\n\r\n'),
    bytes,
    Buffer.from('\r\n--' + boundary + '--'),
  ]);
  const res = await gfetch(
    DRIVE_BASE() + '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=' +
      encodeURIComponent('id,name,mimeType,size,thumbnailLink,webViewLink'),
    { method: 'POST', headers: { 'content-type': 'multipart/related; boundary=' + boundary }, body: body as unknown as BodyInit },
    60000,
  );
  const f = await json<{ id: string; name: string; mimeType: string; size?: string }>(res, 'upload image');
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: new Date().toISOString(),
    size: Number(f.size || 0),
    thumbUrl: 'https://drive.google.com/thumbnail?id=' + f.id + '&sz=w400',
    viewUrl: 'https://drive.google.com/file/d/' + f.id + '/view',
  };
}

/**
 * Download a VIDEO or AUDIO file from Drive, for transcription.
 *
 * Separate from downloadDriveFile above, which is the Image Library's path and
 * refuses anything that is not an image.
 *
 * The cap is on the SOURCE file, and it is about scratch space rather than the
 * transcriber: lib/audio-extract.ts writes the download to the function's /tmp
 * (512 MB) and pulls the audio track out of it, so what actually reaches the
 * transcriber is a couple of megabytes whatever the video weighs. The clinic's
 * reels run 76–283 MB, comfortably inside this.
 */
export const MEDIA_MAX_BYTES = 450 * 1024 * 1024;

export type DriveMedia = { bytes: Buffer; contentType: string; name: string; sizeBytes: number };

export type DriveMediaResult =
  | { ok: true; media: DriveMedia }
  | { ok: false; reason: 'not_media' | 'too_large' | 'unreachable'; message: string; name: string | null; sizeBytes: number | null };

/**
 * Can this file be transcribed at all? One metadata call, no download.
 *
 * Separate from the download below because the dry run needs exactly this and
 * nothing more: sharing the SHEET with the service account grants nothing over
 * the video files it links to, and that is the permission most likely to be
 * missing. Finding out costs one request per row instead of a download each.
 */
export async function probeDriveMedia(fileId: string, maxBytes = MEDIA_MAX_BYTES): Promise<
  { ok: true; name: string; contentType: string; sizeBytes: number | null }
  | { ok: false; reason: 'not_media' | 'too_large' | 'unreachable'; message: string; name: string | null; sizeBytes: number | null }
> {
  let meta: { name: string; mimeType: string; size?: string };
  try {
    const metaRes = await gfetch(
      DRIVE_BASE() + '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent('id,name,mimeType,size') + '&supportsAllDrives=true',
    );
    meta = await json<{ name: string; mimeType: string; size?: string }>(metaRes, 'media metadata');
  } catch (e) {
    // Say which of these it is. "Not shared" is fixed by a person in Drive;
    // the others are not, and telling them apart is the difference between a
    // five-second fix and an afternoon.
    const detail = e instanceof GoogleSourceError && (e.reason === 'not_shared' || e.reason === 'not_found')
      ? 'The dashboard cannot open that Drive file. Share it (or the folder it is in) with ' + (serviceAccountEmail() || 'the service account') + '.'
      : 'Drive did not hand over that file just now.';
    return { ok: false, reason: 'unreachable', message: detail, name: null, sizeBytes: null };
  }
  const size = meta.size ? Number(meta.size) : null;
  if (!/^(video|audio)\//.test(meta.mimeType || '')) {
    return { ok: false, reason: 'not_media', message: 'That Drive file is a ' + (meta.mimeType || 'file') + ', not a video or audio recording.', name: meta.name || null, sizeBytes: size };
  }
  // Checked BEFORE the download, so an oversized file costs one metadata call
  // rather than 200 MB of transfer that is then thrown away.
  if (size !== null && size > maxBytes) {
    return {
      ok: false,
      reason: 'too_large',
      message: 'That video is ' + (size / 1024 / 1024).toFixed(0) + ' MB, past the ' + Math.floor(maxBytes / 1024 / 1024) + ' MB the dashboard can pull down in one go.',
      name: meta.name || null,
      sizeBytes: size,
    };
  }
  return { ok: true, name: meta.name, contentType: meta.mimeType, sizeBytes: size };
}

/**
 * The same file as downloadDriveMedia, as a stream rather than a Buffer.
 *
 * A 283 MB Buffer is 283 MB of function memory held for the whole download;
 * the caller here writes the body to disk as it arrives. Returns the raw
 * Response so the caller owns the body — and with it, the choice of never
 * holding the whole file at once.
 */
export async function driveMediaStream(fileId: string): Promise<Response> {
  return gfetch(DRIVE_BASE() + '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', {}, 180000);
}

export async function downloadDriveMedia(fileId: string, maxBytes = MEDIA_MAX_BYTES): Promise<DriveMediaResult> {
  const probe = await probeDriveMedia(fileId, maxBytes);
  if (!probe.ok) return probe;
  const meta = { name: probe.name, mimeType: probe.contentType };
  const size = probe.sizeBytes;
  const res = await gfetch(DRIVE_BASE() + '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', {}, 120000);
  if (!res.ok) {
    return { ok: false, reason: 'unreachable', message: 'Drive refused the download (HTTP ' + res.status + ').', name: meta.name || null, sizeBytes: size };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  // A file with no size in its metadata (Drive omits it for some shortcuts)
  // still must not sail past the cap.
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: 'too_large', message: 'That video is larger than the ' + Math.floor(maxBytes / 1024 / 1024) + ' MB the dashboard can pull down in one go.', name: meta.name || null, sizeBytes: bytes.byteLength };
  }
  return { ok: true, media: { bytes, contentType: meta.mimeType, name: meta.name, sizeBytes: bytes.byteLength } };
}

export async function downloadDriveFile(fileId: string): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  const metaRes = await gfetch(DRIVE_BASE() + '/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent('id,name,mimeType,size') + '&supportsAllDrives=true');
  const meta = await json<{ name: string; mimeType: string; size?: string }>(metaRes, 'file metadata');
  if (!/^image\//.test(meta.mimeType || '')) throw new GoogleSourceError(415, 'not an image');
  if (meta.size && Number(meta.size) > 25 * 1024 * 1024) throw new GoogleSourceError(413, 'image larger than 25 MB');
  const res = await gfetch(DRIVE_BASE() + '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&supportsAllDrives=true', {}, 60000);
  if (!res.ok) throw new GoogleSourceError(res.status, 'file download failed: HTTP ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: meta.mimeType, name: meta.name };
}

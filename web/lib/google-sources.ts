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

import { google } from 'googleapis';
import { reportError } from '@/lib/report';
import { parseSheetDate, pick, tableFromRows } from '@/lib/sheet-table';

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
    // Least privilege for what this module actually does. Sheets is read AND
    // written (the approvals tab is appended to), but every Drive call here is
    // a read: list the folder, read a file's metadata, download its bytes. The
    // full drive scope would let a bug in this path modify or delete anything
    // the service account can see, including the clip-storage folder that
    // lib/drive.ts owns — that module mints its own token and is unaffected.
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
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
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    // 403/404 here almost always means "not shared with the service account".
    throw new GoogleSourceError(res.status, what + ' failed: HTTP ' + res.status);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

type SheetMeta = { title: string; sheetId: number; index: number };

export async function listTabs(spreadsheetId: string): Promise<SheetMeta[]> {
  const res = await gfetch(SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '?fields=sheets.properties');
  const j = await json<{ sheets?: { properties: { title: string; sheetId: number; index: number } }[] }>(res, 'sheet metadata');
  return (j.sheets || []).map((s) => ({ title: s.properties.title, sheetId: s.properties.sheetId, index: s.properties.index }));
}

export async function readTab(spreadsheetId: string, tab: string): Promise<string[][]> {
  const range = encodeURIComponent("'" + tab.replace(/'/g, "''") + "'");
  const res = await gfetch(SHEETS_BASE() + '/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values/' + range + '?majorDimension=ROWS');
  const j = await json<{ values?: string[][] }>(res, 'sheet read');
  return j.values || [];
}

export type CalendarEntry = {
  tab: string;
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
    const { header, records } = tableFromRows(rows, ['date', 'caption', 'status', 'type of post', 'graphics link', 'file name']);
    // The planning tab ("Content Calendar") has a Date column but no captions;
    // only tabs that hold actual posts count.
    if (!header.some((h) => h.startsWith('caption'))) continue;
    used.push(t.title);
    for (const r of records) {
      const caption = pick(r, 'caption', 'copy');
      const date = parseSheetDate(pick(r, 'date', 'fecha'));
      if (!caption && !date) continue;
      const networks = NETWORK_COLUMNS.filter(([col]) => /^(x|✓|✔|yes|si|sí|true|posted|done)$/i.test(pick(r, col))).map(([, n]) => n);
      entries.push({
        tab: t.title,
        date,
        type: pick(r, 'type of post', 'type', 'tipo'),
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

export type VideoEntry = {
  tab: string;
  creator: string;
  month: string;
  type: string;
  title: string;
  copy: string;
  videoLink: string;
  format: string;
  networks: string[];
  thumbnailTitle: string;
  coverLink: string;
  notes: string;
};

const VIDEO_NETWORKS: [string, string][] = [['youtube', 'youtube'], ['linkedin', 'linkedin'], ['tiktok', 'tiktok'], ['x', 'twitter'], ['facebook', 'facebook'], ['instagram', 'instagram'], ['email', 'email']];

/** The video inventory across every year tab. */
export async function readVideos(spreadsheetId = SOURCE_IDS.videosSheet()): Promise<{ entries: VideoEntry[]; tabs: string[] }> {
  const tabs = (await listTabs(spreadsheetId)).filter((t) => t.title !== APPROVALS_TAB);
  const entries: VideoEntry[] = [];
  for (const t of tabs) {
    let rows: string[][] = [];
    try { rows = await readTab(spreadsheetId, t.title); } catch (e) { reportError('sources:videos-tab', e, { tab: t.title }); continue; }
    const { header, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
    if (!header.length) continue;
    // The first column carries the creator's name and has no header.
    const firstKey = header[0] || 'col0';
    for (const r of records) {
      const title = pick(r, 'título del video', 'titulo del video', 'title');
      const videoLink = pick(r, 'link video', 'link', 'video link');
      if (!title && !videoLink) continue;
      const networks = VIDEO_NETWORKS.filter(([col]) => Boolean(pick(r, col))).map(([, n]) => n);
      entries.push({
        tab: t.title,
        creator: firstKey ? r[firstKey] || '' : '',
        month: pick(r, 'fecha de elaboración', 'fecha', 'month'),
        type: pick(r, 'tipo de video', 'tipo', 'type'),
        title,
        copy: pick(r, 'copy', 'caption'),
        videoLink,
        format: pick(r, 'formato', 'format'),
        networks,
        thumbnailTitle: pick(r, 'título thumbnails', 'titulo thumbnails', 'thumbnail'),
        coverLink: pick(r, 'link portada', 'cover'),
        notes: pick(r, 'observación', 'observacion', 'notes'),
      });
    }
  }
  return { entries, tabs: tabs.map((t) => t.title) };
}

/**
 * Append one approved post to the calendar sheet, on its own tab so nothing
 * Meriz laid out by hand is touched. The tab is created on first use.
 */
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

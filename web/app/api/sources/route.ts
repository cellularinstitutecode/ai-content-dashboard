// GET  /api/sources?kind=status|calendar|videos|images
// POST /api/sources  { action: 'import_image', fileId }
//
// The three Google documents the team plans in (lib/google-sources.ts),
// served to the Sources pages. Reads are cached briefly per process because
// the sheets change a few times a day and the Sheets API is rate-limited per
// minute. Importing an image copies it from Drive into the app's own public
// bucket, because Metricool cannot fetch a Drive link.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import {
  CALENDAR_EDITABLE,
  GoogleSourceError,
  SOURCE_IDS,
  VIDEO_EDITABLE,
  downloadDriveFile,
  listFolderImages,
  readCalendar,
  readRowCells,
  readVideos,
  appendRow,
  updateRowCells,
  uploadFolderImage,
  serviceAccountEmail,
  sourcesConfigured,
} from '@/lib/google-sources';
import { storeBytes } from '@/lib/images';
import { reportError } from '@/lib/report';
import { checkRateLimit } from '@/lib/rate-limit';

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// What to actually DO about each way Google can refuse. The previous version
// said "share it with the service account" for every 403 and 404, which is one
// of at least four causes and was the wrong one on documents already shared
// with anyone-who-has-the-link.
function failure(e: unknown, what: string) {
  reportError('sources:' + what, e);
  if (!(e instanceof GoogleSourceError)) {
    return NextResponse.json({ error: 'google_unavailable', message: 'Google did not answer just now. Try again in a moment.' }, { status: 502 });
  }
  const who = serviceAccountEmail();
  const project = (who || '').split('@')[1]?.split('.')[0] || '';
  const said = e.detail ? ' Google said: “' + e.detail.slice(0, 240) + '”' : '';
  const advice: Record<string, string> = {
    api_disabled:
      'The Google Sheets and Drive APIs are not switched on for this project' + (project ? ' (' + project + ')' : '') +
      '. Enable both in the Google Cloud console — APIs & Services → Library — then reload. Sharing the document again will not help.',
    bad_scopes:
      'The dashboard’s Google credentials do not carry the access this needs. Whoever set it up should re-issue the service-account key; no change to the document will help.',
    bad_credentials:
      'Google rejected the dashboard’s credentials. GOOGLE_SERVICE_ACCOUNT_JSON is missing, malformed or revoked — it needs replacing in the deployment settings.',
    not_shared:
      'The document is not visible to the dashboard’s service account' + (who ? ' (' + who + ')' : '') +
      '. Open it in Google, press Share, and add that address — Viewer is enough for the video and image libraries, Editor for the calendar so approvals can be written back.',
    not_found:
      'Google has no document with the id the dashboard is configured to read. Check the id in the deployment settings against the document’s URL.',
    rate_limited: 'Google is rate-limiting the dashboard. This clears itself; try again in a minute.',
    unknown: 'Google refused this document and did not say why in a way the dashboard recognises.',
  };
  return NextResponse.json(
    {
      error: e.reason,
      message: (advice[e.reason] || advice.unknown) + said,
      serviceAccount: who,
      googleStatus: e.status,
    },
    { status: 502 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const kind = (req.nextUrl.searchParams.get('kind') || 'status').trim();
  const fresh = req.nextUrl.searchParams.get('fresh') === '1';

  if (kind === 'status') {
    return NextResponse.json({
      configured: sourcesConfigured(),
      serviceAccount: serviceAccountEmail(),
      ids: { calendar: SOURCE_IDS.calendarSheet(), videos: SOURCE_IDS.videosSheet(), images: SOURCE_IDS.imagesFolder() },
    }, { headers: { 'cache-control': 'no-store' } });
  }
  if (!sourcesConfigured()) {
    return NextResponse.json({ error: 'not_configured', message: 'Google access is not set up yet — ask whoever set this up to add the service account.' }, { status: 503 });
  }
  try {
    if (kind === 'calendar') return NextResponse.json(await cached('calendar', fresh, () => readCalendar()), { headers: { 'cache-control': 'no-store' } });
    if (kind === 'videos') return NextResponse.json(await cached('videos', fresh, () => readVideos()), { headers: { 'cache-control': 'no-store' } });
    if (kind === 'images') return NextResponse.json({ images: await cached('images', fresh, () => listFolderImages()) }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return failure(e, kind);
  }
  return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
}

/**
 * PATCH /api/sources — edit one row of one of the team's sheets, in place.
 *
 * Body: { kind: 'calendar' | 'videos', tab, row, changes: {field: value},
 *         expected?: {field: value} }
 *
 * Three rules, in this order, because this writes into a document other people
 * are working in at the same time:
 *
 *  1. Only fields on the allowlist for that sheet, resolved to the A1 column
 *     the READER found on that tab. Nothing else is addressable — in
 *     particular the month grid down the left of every calendar tab, which is
 *     Meriz's layout and not data.
 *  2. If `expected` is given, every named cell must still hold that value.
 *     Someone editing the same row in Google while you had the page open loses
 *     nothing: the write is refused and you are told to reload.
 *  3. One row per request.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  if (!sourcesConfigured()) {
    return NextResponse.json({ error: 'not_configured', message: 'Google access is not set up yet.' }, { status: 503 });
  }
  const rl = await checkRateLimit(auth.userId, 'sources-edit');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  const kind = String(body?.kind || '');
  const tab = String(body?.tab || '');
  const row = Number(body?.row);
  const changes = body?.changes && typeof body.changes === 'object' ? body.changes as Record<string, unknown> : null;
  if ((kind !== 'calendar' && kind !== 'videos') || !tab || !Number.isInteger(row) || row < 2 || !changes || !Object.keys(changes).length) {
    return NextResponse.json({ error: 'invalid_request', message: 'Say which sheet, which tab, which row, and what to change.' }, { status: 400 });
  }

  const allowed: readonly string[] = kind === 'calendar' ? CALENDAR_EDITABLE : VIDEO_EDITABLE;
  const bad = Object.keys(changes).filter((f) => !allowed.includes(f));
  if (bad.length) {
    return NextResponse.json(
      { error: 'field_not_editable', message: 'The dashboard does not edit ' + bad.join(', ') + ' on this sheet.', fields: bad },
      { status: 400 },
    );
  }

  try {
    // Ask the READER where these fields live on this tab. Column letters are
    // never taken from the request: a caller cannot name a cell, only a field.
    const sheetId = kind === 'calendar' ? SOURCE_IDS.calendarSheet() : SOURCE_IDS.videosSheet();
    const found = kind === 'calendar'
      ? (await readCalendar()).entries.find((e) => e.tab === tab && e.row === row)
      : (await readVideos()).entries.find((e) => e.tab === tab && e.row === row);
    if (!found) {
      return NextResponse.json({ error: 'row_not_found', message: 'That row is no longer in the sheet. Reload and try again.' }, { status: 409 });
    }
    const columns = found.columns as Record<string, string | undefined>;

    const missing = Object.keys(changes).filter((f) => !columns[f]);
    if (missing.length) {
      return NextResponse.json(
        { error: 'no_such_column', message: 'This tab has no column for ' + missing.join(', ') + '.', fields: missing },
        { status: 400 },
      );
    }

    // Nobody else moved it while the page was open.
    const expected = body?.expected && typeof body.expected === 'object' ? body.expected as Record<string, string> : null;
    if (expected) {
      const cols = Object.keys(expected).filter((f) => columns[f]).map((f) => columns[f] as string);
      const now = await readRowCells(sheetId, tab, row, cols);
      const clashes = Object.keys(expected)
        .filter((f) => columns[f])
        .filter((f) => String(now[columns[f] as string] ?? '') !== String(expected[f] ?? ''));
      if (clashes.length) {
        return NextResponse.json(
          {
            error: 'changed_underneath',
            message: 'Somebody edited this row in Google while you had it open, so nothing was overwritten. Reload to see their version.',
            fields: clashes,
          },
          { status: 409 },
        );
      }
    }

    await updateRowCells(sheetId, tab, row, Object.keys(changes).map((f) => ({
      column: columns[f] as string,
      value: String(changes[f] ?? ''),
    })));
    return NextResponse.json({ ok: true, tab, row, changed: Object.keys(changes) });
  } catch (e) {
    return failure(e, 'edit-' + kind);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  if (!sourcesConfigured()) {
    return NextResponse.json({ error: 'not_configured', message: 'Google access is not set up yet.' }, { status: 503 });
  }
  const rl = await checkRateLimit(auth.userId, 'sources-import');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  // Add a NEW row to one of the sheets — the "type in something new" case.
  // The tab's own column map decides where each field lands, so this cannot
  // write outside the task table any more than an edit can.
  if (body?.action === 'add_row') {
    const kind = String(body?.kind || '');
    const tab = String(body?.tab || '');
    const values = body?.values && typeof body.values === 'object' ? body.values as Record<string, string> : null;
    if ((kind !== 'calendar' && kind !== 'videos') || !tab || !values || !Object.keys(values).length) {
      return NextResponse.json({ error: 'invalid_request', message: 'Say which sheet, which tab, and what to write.' }, { status: 400 });
    }
    const allowedNew: readonly string[] = kind === 'calendar' ? CALENDAR_EDITABLE : VIDEO_EDITABLE;
    const notAllowed = Object.keys(values).filter((f) => !allowedNew.includes(f));
    if (notAllowed.length) {
      return NextResponse.json({ error: 'field_not_editable', message: 'The dashboard does not write ' + notAllowed.join(', ') + '.', fields: notAllowed }, { status: 400 });
    }
    try {
      const sheetId = kind === 'calendar' ? SOURCE_IDS.calendarSheet() : SOURCE_IDS.videosSheet();
      // Take the column map from a row the reader already understands on this
      // tab, so a new row lines up with the ones beside it.
      const sample = kind === 'calendar'
        ? (await readCalendar()).entries.find((e) => e.tab === tab)
        : (await readVideos()).entries.find((e) => e.tab === tab);
      if (!sample) {
        return NextResponse.json({ error: 'unknown_tab', message: 'The dashboard cannot read that tab, so it will not write to it.' }, { status: 400 });
      }
      const { row } = await appendRow(sheetId, tab, sample.columns as Record<string, string | undefined>, values);
      return NextResponse.json({ ok: true, tab, row });
    } catch (e) {
      return failure(e, 'add-row-' + kind);
    }
  }

  // Add a photo to the team's folder. Base64 because the browser sends it
  // through the same JSON endpoint as everything else; 12 MB is Drive-friendly
  // and well under the platform's body cap.
  if (body?.action === 'upload_image') {
    const name = String(body?.name || '').trim().replace(/[/\\]/g, '-').slice(0, 120);
    const contentType = String(body?.contentType || '');
    const b64 = typeof body?.data === 'string' ? body.data.replace(/^data:[^;]+;base64,/, '') : '';
    if (!name || !/^image\/(png|jpe?g|webp|gif)$/.test(contentType) || !b64) {
      return NextResponse.json({ error: 'invalid_request', message: 'Send a PNG, JPEG, WebP or GIF with a name.' }, { status: 400 });
    }
    let bytes: Buffer;
    try { bytes = Buffer.from(b64, 'base64'); } catch { bytes = Buffer.alloc(0); }
    if (!bytes.length) return NextResponse.json({ error: 'invalid_request', message: 'That file was empty.' }, { status: 400 });
    if (bytes.length > 12 * 1024 * 1024) {
      return NextResponse.json({ error: 'too_large', message: 'That image is over 12 MB. Please add it in Drive directly.' }, { status: 413 });
    }
    try {
      const image = await uploadFolderImage(bytes, contentType, name);
      return NextResponse.json({ image });
    } catch (e) {
      return failure(e, 'upload-image');
    }
  }

  if (body?.action !== 'import_image' || typeof body.fileId !== 'string' || !/^[A-Za-z0-9_-]{10,}$/.test(body.fileId)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    const file = await downloadDriveFile(body.fileId);
    const ext = file.contentType === 'image/png' ? 'png' : file.contentType === 'image/webp' ? 'webp' : file.contentType === 'image/gif' ? 'gif' : 'jpg';
    const url = await storeBytes(file.bytes, file.contentType, ext, file.name.replace(/\.[a-z0-9]+$/i, ''));
    return NextResponse.json({ url, name: file.name });
  } catch (e) {
    if (e instanceof GoogleSourceError && (e.status === 413 || e.status === 415)) {
      return NextResponse.json({ error: 'unusable_file', message: e.status === 413 ? 'That image is larger than 25 MB.' : 'That file is not an image.' }, { status: 422 });
    }
    return failure(e, 'import_image');
  }
}

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
  GoogleSourceError,
  SOURCE_IDS,
  downloadDriveFile,
  listFolderImages,
  readCalendar,
  readVideos,
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

function failure(e: unknown, what: string) {
  reportError('sources:' + what, e);
  if (e instanceof GoogleSourceError && (e.status === 403 || e.status === 404)) {
    return NextResponse.json(
      {
        error: 'not_shared',
        message: 'Google refused this document for the dashboard. Share it with the service account as Editor' +
          (serviceAccountEmail() ? ' (' + serviceAccountEmail() + ')' : '') + ' and try again.',
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ error: 'google_unavailable', message: 'Google did not answer just now. Try again in a moment.' }, { status: 502 });
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

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { opusGetExportableClips } from '@/lib/opus';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { persistToDrive } from '@/lib/drive';

export const runtime = 'nodejs';
// Drive uploads take time; give the webhook room so clips finish persisting.
export const maxDuration = 60;

// Opus signs every webhook: signature = HMAC-SHA256(secretKey, rawBody + salt).
// Headers: X-Opus-Signature (hex), X-Opus-Salt (hex), X-Opus-Timestamp (unix sec).
// See https://help.opus.pro/api-reference/webhook

// Small in-memory replay guard. Serverless instances are ephemeral, so this only
// blocks replays hitting the same warm instance; combined with the 5-min freshness
// window it is a reasonable best-effort without external state.
const seenSalts = new Set<string>();

function verify(rawBody: string, headers: Headers, secret: string): boolean {
  const salt = headers.get('x-opus-salt') || '';
  const received = headers.get('x-opus-signature') || '';
  const timestamp = parseInt(headers.get('x-opus-timestamp') || '', 10);
  if (!salt || !received || Number.isNaN(timestamp)) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody + salt).digest('hex');
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  const sigValid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!sigValid) return false;

  const fresh = Math.abs(Math.floor(Date.now() / 1000) - timestamp) < 300;
  if (!fresh) return false;

  if (seenSalts.has(salt)) return false;
  seenSalts.add(salt);
  if (seenSalts.size > 5000) seenSalts.clear();
  return true;
}

// Best-effort extraction of a project id from an arbitrary webhook payload,
// normalized to a trimmed string so it keys drafts exactly like the create/poll
// paths do.
function extractProjectId(payload: any): string | null {
  const raw =
    payload?.projectId ||
    payload?.project?.id ||
    payload?.project?.projectId ||
    payload?.data?.projectId ||
    payload?.id ||
    null;
  const s = raw == null ? '' : String(raw).trim();
  return s || null;
}

// Locate the gallery draft for a project. The webhook has no user session, so we
// match on the JSON projectId key first, then fall back to the source_url stored
// on the clips bookkeeping row (which is keyed by opus_project_id). This mirrors
// the fallback in the clip route so both the fast path (webhook) and the fallback
// path (poll) resolve the same draft even if the id was written in an odd shape.
async function findClipDraft(admin: any, projectId: string) {
  const byKey = await admin
    .from('drafts')
    .select('id, pack')
    .filter('pack->>projectId', 'eq', projectId)
    .limit(1);
  if (byKey.data && byKey.data[0]) return byKey.data[0];

  const clipRow = await admin
    .from('clips')
    .select('source_url')
    .eq('opus_project_id', projectId)
    .limit(1);
  const sourceUrl = clipRow.data && clipRow.data[0] && clipRow.data[0].source_url;
  if (!sourceUrl) return null;
  const byUrl = await admin
    .from('drafts')
    .select('id, pack')
    .filter('pack->>video', 'eq', sourceUrl)
    .filter('pack->>kind', 'eq', 'clip')
    .order('created_at', { ascending: false })
    .limit(1);
  return (byUrl.data && byUrl.data[0]) || null;
}

// Copy each finished clip's MP4 into Google Drive while Opus's signed link is
// still valid, and swap in the permanent Drive URL. If a single clip fails to
// persist we keep the original Opus link for that one clip rather than dropping
// it, so a partial failure never loses data.
async function persistClips(clips: any[], projectId: string): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const src = clip.export || clip.preview;
    if (!src) { out.push(clip); continue; }
    try {
      const filename = 'clip-' + projectId + '-' + (i + 1) + '.mp4';
      const { fileId, url } = await persistToDrive(src, filename);
      out.push({ ...clip, preview: url, export: url, driveFileId: fileId, opusExport: clip.export });
    } catch (e) {
      out.push({ ...clip, driveError: (e as any)?.message || 'persist failed' });
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const secret = process.env.OPUS_WEBHOOK_SECRET || process.env.OPUS_API_KEY;
  if (!secret) {
    // Without a secret we cannot verify authenticity - refuse rather than trust.
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  // Read the RAW body exactly as received; re-serializing would break the signature.
  const rawBody = await req.text();
  if (!verify(rawBody, req.headers, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: any = {};
  try { payload = JSON.parse(rawBody); } catch { payload = {}; }

  const projectId = extractProjectId(payload);
  if (!projectId) {
    // Acknowledge so Opus does not retry a payload we cannot route.
    return NextResponse.json({ ok: true, note: 'no projectId in payload' });
  }

  try {
    // Pull the authoritative finished clips from Opus for this project.
    const rawClips = await opusGetExportableClips(projectId).catch(() => []);
    const failed = payload?.type === 'FAILURE' || payload?.status === 'FAILED';
    const status = failed ? 'FAILED' : (rawClips.length > 0 ? 'ready' : 'processing');

    // Persist to Drive while tokens are valid, then store permanent links.
    const clips = status === 'ready' ? await persistClips(rawClips, projectId) : rawClips;

    const admin = supabaseAdmin();

    // Update the gallery draft (pack.kind === 'clip') keyed by projectId.
    const row = await findClipDraft(admin, projectId);
    if (row) {
      const pack = { ...(row.pack || {}), projectId, clips, status };
      await admin.from('drafts').update({ pack, updated_at: new Date().toISOString() }).eq('id', row.id);
    }

    // Update the clips bookkeeping row too.
    await admin.from('clips').update({ status, result: clips }).eq('opus_project_id', projectId);

    return NextResponse.json({ ok: true, status, count: clips.length, matched: !!row });
  } catch (e: any) {
    // Return 200 so Opus does not hammer retries on a transient DB error; we log via message.
    return NextResponse.json({ ok: false, error: e?.message || 'handler error' });
  }
}

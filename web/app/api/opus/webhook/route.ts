import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { opusGetExportableClips } from '@/lib/opus';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

// Opus signs every webhook: signature = HMAC-SHA256(secretKey, rawBody + salt).
// Headers: X-Opus-Signature (hex), X-Opus-Salt (hex), X-Opus-Timestamp (unix sec).
// See https://help.opus.pro/api-reference/webhook

// Small in-memory replay guard. Serverless instances are ephemeral, so this only
// blocks replays hitting the same warm instance; combined with the 5-min freshness
// window it is a reasonable best effort without external state.
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

// Best-effort extraction of a project id from an arbitrary webhook payload.
function extractProjectId(payload: any): string | null {
  return (
    payload?.projectId ||
    payload?.project?.id ||
    payload?.project?.projectId ||
    payload?.data?.projectId ||
    payload?.id ||
    null
  );
}

export async function POST(req: NextRequest) {
  const secret = process.env.OPUS_WEBHOOK_SECRET || process.env.OPUS_API_KEY;
  if (!secret) {
    // Without a secret we cannot verify authenticity — refuse rather than trust.
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
    const clips = await opusGetExportableClips(projectId).catch(() => []);
    const failed = payload?.type === 'FAILURE' || payload?.status === 'FAILED';
    const status = failed ? 'failed' : (clips.length > 0 ? 'ready' : 'processing');

    const admin = supabaseAdmin();

    // Update the gallery draft (pack.kind === 'clip') keyed by projectId.
    const { data: rows } = await admin
      .from('drafts')
      .select('id, pack')
      .filter('pack->>projectId', 'eq', projectId)
      .limit(1);
    const row = rows && rows[0];
    if (row) {
      const pack = { ...(row.pack || {}), clips, status };
      await admin.from('drafts').update({ pack, updated_at: new Date().toISOString() }).eq('id', row.id);
    }

    // Update the clips bookkeeping row too.
    await admin.from('clips').update({ status, result: clips }).eq('opus_project_id', projectId);

    return NextResponse.json({ ok: true, status, count: clips.length });
  } catch (e: any) {
    // Return 200 so Opus does not hammer retries on a transient DB error; we log via message.
    return NextResponse.json({ ok: false, error: e?.message || 'handler error' });
  }
}

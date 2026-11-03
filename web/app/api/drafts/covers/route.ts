// GET  /api/drafts/covers → how many titled covers were made before the new
//                            cover rule, are not yet redone, and are not yet
//                            posted, with their titles.
// POST /api/drafts/covers → redo up to `limit` of them: each is re-rendered on
//                            its clean photograph with lib/title-cover.ts (no
//                            image model, no credits), its record stamped, and
//                            the head flag dropped (lib/cover-redo.ts). The
//                            answer names the posts in Metricool that still
//                            carry the old picture, for the client to sync.
//
// Why a route of its own: Apply title (app/api/drafts/image) does one draft a
// press, and sixty covers were made before the rule.
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';
import { retitleImage } from '@/lib/retitle';
import { isOldCover, unpublishedOnly, withoutHeadFlag } from '@/lib/cover-redo';
import type { PackImage } from '@/lib/images';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Redone per call at most; the client calls again while `remaining` is above zero. */
const PER_CALL = 12;
/** Stop starting another cover with less than this much of the function's time left. */
const STOP_BEFORE_MS = 30_000;

type DraftRow = { id: string; topic: string | null; pack: Record<string, unknown> | null; created_at?: string };

async function oldCovers(sb: Awaited<ReturnType<typeof supabaseServer>>, userId: string): Promise<DraftRow[]> {
  const { data, error } = await sb
    .from('drafts')
    .select('id, topic, pack, created_at')
    .eq('user_id', userId)
    .not('pack->_image->titled->>photoUrl', 'is', null)
    .order('created_at', { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);
  const old = ((data || []) as DraftRow[]).filter((d) => isOldCover((d.pack as { _image?: PackImage } | null)?._image));
  if (!old.length) return old;
  // Only what is still to come. A cover already posted is history, and the
  // clinic's instruction is that everything NOT yet posted looks like the
  // profile — a draft with a published post is left exactly as it is.
  const { data: posts, error: postsErr } = await sb
    .from('posts')
    .select('draft_id, status')
    .eq('user_id', userId)
    .in('draft_id', old.map((d) => d.id));
  if (postsErr) throw new Error(postsErr.message);
  return unpublishedOnly(old, (posts || []) as { draft_id: string | null; status: string | null }[]);
}

export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const rows = await oldCovers(sb, user.id);
    return NextResponse.json({
      count: rows.length,
      covers: rows.slice(0, 100).map((d) => ({ id: d.id, title: String((d.pack as { _image?: PackImage })?._image?.titled?.title || ''), topic: d.topic })),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    reportError('drafts-covers:get', e);
    return NextResponse.json({ error: 'unreadable', message: 'The covers could not be listed just now.' }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Free, but it stores a PNG per cover: the title bucket, as Apply title is.
  const rl = await checkRateLimit(user.id, 'title');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: { limit?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { body = {}; }
  const limit = Math.min(PER_CALL, Math.max(1, Number(body.limit) || PER_CALL));

  let rows: DraftRow[];
  try { rows = await oldCovers(sb, user.id); } catch (e) {
    reportError('drafts-covers:list', e);
    return NextResponse.json({ error: 'unreadable', message: 'The covers could not be listed just now.' }, { status: 503 });
  }

  const done: { id: string; title: string; url: string; postIds: string[] }[] = [];
  const failed: { id: string; title: string; message: string }[] = [];
  for (const d of rows.slice(0, limit)) {
    if (Date.now() - started > maxDuration * 1000 - STOP_BEFORE_MS) break;
    const pack = (d.pack || {}) as Record<string, unknown>;
    const existing = pack._image as PackImage;
    const title = String(existing.titled?.title || '');
    try {
      const made = await retitleImage(existing, title, d.topic || 'cover');
      const next: PackImage = { ...made, verification: withoutHeadFlag(made.verification) ?? made.verification, coverRedone: true };
      // Re-read before writing: the draft may have moved on while this rendered.
      const { data: fresh } = await sb.from('drafts').select('pack').eq('id', d.id).eq('user_id', user.id).maybeSingle();
      const current = ((fresh as { pack?: Record<string, unknown> } | null)?.pack || pack) as Record<string, unknown>;
      const { error: upErr } = await sb.from('drafts').update({ pack: { ...current, _image: next } }).eq('id', d.id).eq('user_id', user.id);
      if (upErr) throw new Error(upErr.message);
      // The posts in Metricool that still carry the old picture.
      const { data: posts } = await sb.from('posts').select('id, status, metricool_post_id').eq('draft_id', d.id).eq('user_id', user.id);
      const postIds = ((posts || []) as { id: string; status: string | null; metricool_post_id: string | null }[])
        .filter((p) => p.metricool_post_id && p.status !== 'published' && p.status !== 'failed')
        .map((p) => p.id);
      done.push({ id: d.id, title, url: next.url, postIds });
    } catch (e) {
      reportError('drafts-covers:redo', e, { id: d.id });
      failed.push({ id: d.id, title, message: e instanceof Error ? e.message : 'the cover could not be redone' });
    }
  }
  const remaining = Math.max(0, rows.length - done.length - failed.length);
  return NextResponse.json({ done, failed, remaining }, { headers: { 'cache-control': 'no-store' } });
}

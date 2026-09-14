// web/app/api/drafts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { IMAGE_BUCKET, removeStoredObjects } from '@/lib/images';
import { referencedKeys } from '@/lib/storage-prune';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Pagination: ?limit (1-50, default 10) & ?offset (>=0, default 0).
  const url = req.nextUrl;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 50);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

  const { data, error, count } = await sb
    .from('drafts')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ drafts: data, total: count ?? 0, limit, offset });
}

export async function POST(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { topic, audience, tone, goal, cta, channels, pack, provider } = body || {};
  if (!topic || !pack) {
    return NextResponse.json({ error: 'topic+pack required' }, { status: 400 });
  }

  const { data, error } = await sb
    .from('drafts')
    .insert({
      user_id: user.id,
      topic,
      audience: audience ?? null,
      tone: tone ?? null,
      goal: goal ?? null,
      cta: cta ?? null,
      channels: channels ?? null,
      pack,
      provider: provider ?? null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ draft: data });
}

export async function PATCH(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const { id, topic, pack } = body || {};
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof topic === 'string') patch.topic = topic;
  if (pack !== undefined) patch.pack = pack;

  const { data, error } = await sb
    .from('drafts')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  // PGRST116 = "no (or multiple) rows returned" — i.e. the id does not belong
  // to this user, or no longer exists. That is a 404, not a server fault.
  if (error && (error as any).code === 'PGRST116') {
    return NextResponse.json({ error: 'draft not found' }, { status: 404 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ draft: data });
}

export async function DELETE(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // Read the pack BEFORE the row goes: its images go with it. This used to be
  // a bare row delete, which left the hero image and the whole carousel in the
  // public bucket for good — one click, several megabytes, unreachable and
  // still billed. The read is best-effort: a draft that cannot be read is
  // still deleted, it just leaves its images for the nightly sweep to find.
  const { data: before } = await sb
    .from('drafts')
    .select('pack')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  const { error } = await sb
    .from('drafts')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Awaited, not fired-and-forgotten: a serverless function is frozen the
  // moment it answers, and work left running then may simply never happen.
  const pack = (before as { pack?: unknown } | null)?.pack;
  if (pack) await removeDraftImages(pack).catch((e) => reportError('drafts:delete-images', e, { id }));
  return NextResponse.json({ ok: true });
}

/**
 * Remove the objects a deleted draft referenced — unless another draft still
 * points at one of them.
 *
 * Sharing is not something the app does today (every generation and every
 * card render writes its own object), but a delete is permanent and the check
 * is one indexed read per key, so it is made rather than assumed. Cards are
 * rendered per draft by construction; the hero is the field a copy would
 * carry, so that is the field checked. Anything skipped here is still caught
 * by the nightly sweep once nothing references it.
 */
async function removeDraftImages(pack: unknown): Promise<void> {
  const keys = [...referencedKeys([pack], IMAGE_BUCKET)];
  if (!keys.length) return;
  const admin = supabaseAdmin();
  const free: string[] = [];
  for (const key of keys) {
    // `like` treats `_` as a wildcard, which can only over-match — and an
    // over-match here means "keep the file", the safe direction.
    const { data, error } = await admin
      .from('drafts')
      .select('id')
      .like('pack->_image->>url', '%/' + key)
      .limit(1);
    // Cannot tell → do not delete. The sweep decides later, with the whole picture.
    if (error) continue;
    if (Array.isArray(data) && data.length) continue;
    free.push(key);
  }
  await removeStoredObjects(free);
}

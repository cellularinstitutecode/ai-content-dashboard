// web/app/api/drafts/route.ts
import { APPROVED_STATUS } from '@/lib/post-mode';
import { NextRequest, NextResponse } from 'next/server';
import { parseDriveFileId } from '@/lib/drive-url';
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

  // ONE draft, by id.
  //
  // The Video Library's "Use in post" needs the copy this app PREPARED for a
  // row, and the only way to reach it was to page through every draft looking
  // for one — so the button handed over the sheet's own column instead, and a
  // row prepared by the dashboard went to Metricool with text nobody had
  // written for it.
  const wanted = (req.nextUrl.searchParams.get('id') || '').trim();
  if (wanted) {
    const { data: one, error: oneErr } = await sb
      .from('drafts').select('*').eq('id', wanted).eq('user_id', user.id).maybeSingle();
    if (oneErr) return NextResponse.json({ error: oneErr.message }, { status: 500 });
    if (!one) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ draft: one });
  }

  // THE DRAFT FOR A VIDEO, by the video itself.
  //
  // "Use in post" looked the draft up by sheet ROW, through video_runs — and
  // video_runs is the SWEEP's memory: pressing Prepare by hand records only
  // failures there. So a row somebody had just prepared looked unprepared, the
  // button fell back to the sheet's Copy column, and the post went to the
  // composer with no REF line and no AVISO: "when I click use post with video
  // itself it's not ready, no DOI number".
  //
  // The video is the key both sides always have. Every video draft's pack
  // carries the sourceUrl it was written from, and the row carries the same
  // link, so this matches on the Drive file id and takes the newest.
  const forVideo = (req.nextUrl.searchParams.get('videoLink') || '').trim();
  if (forVideo) {
    const wantedFile = parseDriveFileId(forVideo) || forVideo;
    const { data: recent, error: recentErr } = await sb
      .from('drafts').select('*').eq('user_id', user.id)
      .order('updated_at', { ascending: false }).limit(60);
    if (recentErr) return NextResponse.json({ error: recentErr.message }, { status: 500 });
    const match = (recent || []).find((d) => {
      const pack = ((d as { pack?: Record<string, unknown> | null }).pack || {}) as Record<string, unknown>;
      if (pack.kind !== 'video') return false;
      const src = typeof pack.sourceUrl === 'string' ? pack.sourceUrl : '';
      if (!src) return false;
      return (parseDriveFileId(src) || src) === wantedFile;
    });
    return NextResponse.json({ draft: match ?? null });
  }

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
  // Which of these a person has approved (a post row that said yes): the list
  // marks them, and "Delete all except approved" keeps them.
  const approved = await approvedDraftIds(sb, user.id, (data || []).map((d) => String((d as { id: string }).id)));
  const drafts = (data || []).map((d) => (approved.has(String((d as { id: string }).id)) ? { ...(d as Record<string, unknown>), approved: true } : d));
  return NextResponse.json({ drafts, total: count ?? 0, limit, offset });
}

/** Post statuses that mean a person said yes (or it already went out). */
const APPROVED_LIKE = new Set([APPROVED_STATUS, 'published', 'sent', 'live']);

/** The drafts among `ids` that have an approved (or published) post. Never throws: unreadable reads as "none". */
async function approvedDraftIds(sb: Awaited<ReturnType<typeof supabaseServer>>, userId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  try {
    const { data } = await sb.from('posts').select('draft_id, status').eq('user_id', userId).in('draft_id', ids);
    for (const row of (data || []) as { draft_id: string | null; status: string | null }[]) {
      if (row.draft_id && APPROVED_LIKE.has(String(row.status || '').toLowerCase())) out.add(String(row.draft_id));
    }
  } catch (e) {
    reportError('drafts:approved-lookup', e);
  }
  return out;
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

/** The most drafts one request may delete. The list checks 10 at a time; a person cannot reach this. */
const MAX_BULK_DELETE = 100;

// DELETE /api/drafts?id=<one>  or  ?ids=<a>,<b>,<c>
//
// Several at once, for the checkboxes on Recent Drafts. Each draft is
// removed exactly as a single delete removes it — its images go with it —
// and one that fails does not stop the rest: the answer says how many went
// and which did not, so the list can show what is left.
export async function DELETE(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const one = (req.nextUrl.searchParams.get('id') || '').trim();
  const many = (req.nextUrl.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ids = Array.from(new Set(one ? [one, ...many] : many));
  if (!ids.length) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (ids.length > MAX_BULK_DELETE) {
    return NextResponse.json({ error: 'too_many', message: 'At most ' + MAX_BULK_DELETE + ' drafts can be deleted at once.' }, { status: 400 });
  }
  // ?keepApproved=1: a draft a person approved (its post said yes, or went
  // out) is kept and reported, not deleted. Without it, everything asked for
  // goes — the post row keeps its copy of the text (draft_id is set null).
  const keepApproved = ['1', 'true', 'yes'].includes(String(req.nextUrl.searchParams.get('keepApproved') || '').toLowerCase());
  const protectedIds = keepApproved ? await approvedDraftIds(sb, user.id, ids) : new Set<string>();

  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const kept: string[] = [];
  for (const id of ids) {
    if (protectedIds.has(id)) { kept.push(id); continue; }
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
    if (error) { failed.push({ id, error: error.message }); continue; }
    deleted.push(id);

    // Awaited, not fired-and-forgotten: a serverless function is frozen the
    // moment it answers, and work left running then may simply never happen.
    const pack = (before as { pack?: unknown } | null)?.pack;
    if (pack) await removeDraftImages(pack).catch((e) => reportError('drafts:delete-images', e, { id }));
  }

  if (!deleted.length && failed.length) {
    return NextResponse.json({ error: failed[0]?.error || 'delete failed', deleted, failed, kept }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted, failed, kept });
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

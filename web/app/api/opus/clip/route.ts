import { NextRequest, NextResponse } from 'next/server';
import { opusCreateClipProject, opusGetExportableClips } from '@/lib/opus';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

// Pull the Opus project id out of whatever shape the create response uses.
function projectIdOf(project: any): string | null {
  return project?.projectId || project?.id || null;
}

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    // Rate limit before kicking off an Opus clip job.
    const rl = await checkRateLimit(user.id, 'opus-clip');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const { videoUrl, brandTemplateId, language, title } = await req.json();
    if (!videoUrl) return NextResponse.json({ error: 'videoUrl required' }, { status: 400 });

    const project = await opusCreateClipProject({ videoUrl, brandTemplateId, language, title });
    const projectId = projectIdOf(project);

    // Record the job so it shows up in stats. The user-facing gallery item is a
    // draft (pack.kind === 'clip') created by the client, keyed by this projectId.
    const admin = supabaseAdmin();
    await admin.from('clips').insert({
      user_id: user.id,
      opus_project_id: projectId,
      source_url: videoUrl,
      status: 'processing',
    });

    // Surface projectId + thumbnail so the client can persist them on the draft.
    return NextResponse.json({
      ok: true,
      projectId,
      thumbnailUrl: project?.sourceInfo?.thumbnailUrl || null,
      title: project?.sourceInfo?.title || null,
      project,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'opus failed' }, { status: 500 });
  }
}

// Poll finished clips for a project. Also persists them onto the matching clip
// draft so the gallery can render playable/downloadable results without Opus
// having to fire the webhook (webhook is the fast path; this is the fallback).
export async function GET(req: NextRequest) {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

    const clips = await opusGetExportableClips(projectId);
    const ready = clips.length > 0;

    // Best-effort persist onto this user's clip draft for the project.
    try {
      const admin = supabaseAdmin();
      const { data: rows } = await admin
        .from('drafts')
        .select('id, pack')
        .eq('user_id', user.id)
        .filter('pack->>projectId', 'eq', projectId)
        .limit(1);
      const row = rows && rows[0];
      if (row) {
        const pack = { ...(row.pack || {}), clips, status: ready ? 'ready' : 'processing' };
        await admin.from('drafts').update({ pack, updated_at: new Date().toISOString() }).eq('id', row.id);
      }
      if (ready) {
        await admin.from('clips').update({ status: 'ready', result: clips }).eq('opus_project_id', projectId);
      }
    } catch {}

    return NextResponse.json({ ok: true, status: ready ? 'ready' : 'processing', clips });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'opus failed' }, { status: 500 });
  }
}

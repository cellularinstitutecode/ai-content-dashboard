import { NextRequest, NextResponse } from 'next/server';
import { opusCreateClipProject, opusGetClips } from '@/lib/opus';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    // Rate limit before kicking off an Opus clip job (fails open if usage_events is absent).
    const rl = await checkRateLimit(user.id, 'opus-clip');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const { videoUrl, brandTemplateId, language } = await req.json();
    if (!videoUrl) return NextResponse.json({ error: 'videoUrl required' }, { status: 400 });

    const project = await opusCreateClipProject({ videoUrl, brandTemplateId, language });

    const admin = supabaseAdmin();
    await admin.from('clips').insert({
      user_id: user.id,
      opus_project_id: project?.projectId || project?.id || null,
      source_url: videoUrl,
      status: 'processing'
    });

    return NextResponse.json({ ok: true, project });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'opus failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

    const clips = await opusGetClips(projectId);
    return NextResponse.json({ ok: true, clips });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'opus failed' }, { status: 500 });
  }
}

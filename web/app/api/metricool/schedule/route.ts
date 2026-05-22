import { NextRequest, NextResponse } from 'next/server';
import { metricoolSchedulePost, type Provider } from '@/lib/metricool';
import { supabaseServer, supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    // Require auth so random visitors can't burn through your Metricool quota.
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = await req.json();
    const { text, providers, publicationDate, firstCommentText, media, autoPublish, draftId } = body || {};
    if (!text || !providers?.length || !publicationDate) {
      return NextResponse.json({ error: 'text, providers[], publicationDate required' }, { status: 400 });
    }

    const result = await metricoolSchedulePost({
      text,
      providers: providers as Provider[],
      publicationDate,
      firstCommentText,
      media,
      autoPublish
    });

    // Log to Supabase posts table for the dashboard counters
    const admin = supabaseAdmin();
    await admin.from('posts').insert({
      user_id: user.id,
      draft_id: draftId ?? null,
      providers,
      text,
      publication_date: publicationDate,
      metricool_post_id: result?.id ?? null,
      status: 'scheduled'
    });

    return NextResponse.json({ ok: true, metricool: result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'schedule failed' }, { status: 500 });
  }
}

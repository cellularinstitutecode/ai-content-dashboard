// web/app/api/templates/apply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { SCHEDULE_TZ, upcomingSlots } from '@/lib/timezone';

export const runtime = 'nodejs';

// POST /api/templates/apply
// Body: { id: string, weeks?: number }
// Materializes upcoming scheduled posts from a template for the next N weeks
// (default 4). For each active weekday in the template, creates one post per
// week at the template's time-of-day, starting from the next matching day.
export async function POST(req: NextRequest) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const id = body && body.id;
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const weeks = Math.min(Math.max(Number(body.weeks) || 4, 1), 12);

  const { data: tpl, error: tErr } = await sb
    .from('schedule_templates')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  if (!tpl) return NextResponse.json({ error: 'template not found' }, { status: 404 });

  const weekdays: number[] = Array.isArray(tpl.weekdays) ? tpl.weekdays : [];
  const providers: string[] = Array.isArray(tpl.providers) ? tpl.providers : [];
  if (weekdays.length === 0) {
    return NextResponse.json({ error: 'template has no weekdays selected' }, { status: 400 });
  }
  if (providers.length === 0) {
    return NextResponse.json({ error: 'template has no providers selected' }, { status: 400 });
  }

  // Template times are clinic-local wall-clock times (America/Cancun by
  // default) — build the instants through the shared timezone helper so a
  // 09:00 template lands at 09:00 in Cancun, not 09:00 UTC.
  const rows: any[] = upcomingSlots(
    weekdays,
    tpl.time_of_day || '09:00',
    weeks * 7,
    SCHEDULE_TZ
  ).map((d) => ({
    user_id: user.id,
    providers,
    text: tpl.text || '',
    publication_date: d.toISOString(),
    status: 'scheduled',
  }));

  if (rows.length === 0) {
    return NextResponse.json({ created: 0, posts: [] });
  }

  const { data, error } = await sb.from('posts').insert(rows).select('*');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ created: (data ?? []).length, posts: data ?? [] });
}

// web/app/api/templates/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// A schedule template: what to post and on which weekly cadence.
type TemplateInput = {
  id?: string;
  name?: string;
  providers?: string[];
  text?: string;
  weekdays?: number[]; // 0=Sun .. 6=Sat
  time_of_day?: string; // "HH:MM"
  active?: boolean;
};

function cleanWeekdays(x: any): number[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<number>();
  for (const v of x) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

function cleanTime(x: any): string {
  const s = (x ?? '').toString();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '09:00';
}

// GET /api/templates â list the user's templates.
export async function GET() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await sb
    .from('schedule_templates')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  if (error) {
    // If the schedule_templates table hasn't been created yet, treat it as no templates
    // rather than surfacing a 500 to the UI.
    const code = (error as any)?.code;
    const msg = String((error as any)?.message || '');
    const missingTable = code === '42P01' || code === 'PGRST205' || /schema cache|does not exist|could not find the table/i.test(msg);
    if (missingTable) return NextResponse.json({ templates: [] });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ templates: data ?? [] });
}

// POST /api/templates â create or update a template (upsert when id is present).
export async function POST(req: NextRequest) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body: TemplateInput = await req.json().catch(() => ({}));

  const row: any = {
    user_id: user.id,
    name: (body.name ?? '').toString().slice(0, 200) || 'Untitled template',
    providers: Array.isArray(body.providers) ? body.providers.map((p) => p.toString()) : [],
    text: (body.text ?? '').toString(),
    weekdays: cleanWeekdays(body.weekdays),
    time_of_day: cleanTime(body.time_of_day),
    active: body.active === false ? false : true,
    updated_at: new Date().toISOString(),
  };
  if (body.id) row.id = body.id;

  const { data, error } = await sb
    .from('schedule_templates')
    .upsert(row)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}

// DELETE /api/templates?id=... â remove a template the user owns.
export async function DELETE(req: NextRequest) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { error } = await sb
    .from('schedule_templates')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

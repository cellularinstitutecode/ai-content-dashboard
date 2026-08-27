// web/app/api/posts/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';

// GET /api/posts
// Returns the current user's scheduled posts, most recent publication first.
export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await sb
    .from('posts')
    .select('*')
    .eq('user_id', user.id)
    .order('publication_date', { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ posts: data ?? [] });
}

// PATCH /api/posts
// Reschedules a single post by updating its publication_date.
// Body: { id: string, publication_date: string (ISO) }
export async function PATCH(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const id = body && body.id;
  const publicationDate = body && body.publication_date;
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }
  if (!publicationDate || typeof publicationDate !== 'string') {
    return NextResponse.json({ error: 'publication_date is required' }, { status: 400 });
  }
  if (isNaN(new Date(publicationDate).getTime())) {
    return NextResponse.json({ error: 'publication_date must be a valid ISO date' }, { status: 400 });
  }

  const { data, error } = await sb
    .from('posts')
    .update({ publication_date: publicationDate })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('*')
    .single();
  // PGRST116 = "no (or multiple) rows returned": the post belongs to someone
  // else or was deleted. The calendar used to report this as a 500.
  if (error && (error as any).code === 'PGRST116') {
    return NextResponse.json({ error: 'post not found' }, { status: 404 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ post: data });
}

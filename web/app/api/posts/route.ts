// web/app/api/posts/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { metricoolDeletePost, metricoolUpdatePostDate } from '@/lib/metricool';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// Both mutating paths now make an upstream Metricool call before they touch the
// local row, so the default 10s budget is too tight.
export const maxDuration = 30;

// GET /api/posts
// Returns the current user's scheduled posts, most recent publication first.
export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { data, error } = await sb
    .from('posts')
    .eq('user_id', user.id)
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
//
// A post that lives in Metricool is moved THERE first. This route used to
// update only the local row, so the queue and the calendar showed the new time
// while Metricool still published on the old one — an action that looked like
// it worked and silently hadn't. If the upstream move fails we return 502 and
// leave the local row untouched, so the two sides can never disagree.
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

  const { data: existing, error: findErr } = await sb
    .from('posts')
    .select('id, metricool_post_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: 'post not found' }, { status: 404 });

  if (existing.metricool_post_id) {
    try {
      await metricoolUpdatePostDate(String(existing.metricool_post_id), publicationDate);
    } catch (e) {
      reportError('posts:metricool-reschedule', e);
      return NextResponse.json(
        {
          error: 'metricool_update_failed',
          message: 'We could not move this post in Metricool, so it has been left where it was. Open it in Metricool to change the time there.',
        },
        { status: 502 },
      );
    }
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

// DELETE /api/posts?id=...
//
// There was no delete at all, which is how a single mis-click on "Apply
// template" could put weeks of posts on the calendar that no screen in the app
// could remove. Deleting removes the Metricool copy first (a post Metricool no
// longer has counts as already deleted) and only then drops the local row, so a
// failure here never leaves an orphan live in Metricool.
export async function DELETE(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data: existing, error: findErr } = await sb
    .from('posts')
    .select('id, metricool_post_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: 'post not found' }, { status: 404 });

  if (existing.metricool_post_id) {
    try {
      await metricoolDeletePost(String(existing.metricool_post_id));
    } catch (e) {
      reportError('posts:metricool-delete', e);
      return NextResponse.json(
        {
          error: 'metricool_delete_failed',
          message: 'We could not remove this post from Metricool, so nothing was deleted. Try again, or delete it in Metricool.',
        },
        { status: 502 },
      );
    }
  }

  const { data: removed, error } = await sb
    .from('posts')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // RLS refuses a delete by returning zero rows, not an error. Without the
  // "posts: owner delete" policy from supabase/schema.sql this route would
  // report success while deleting nothing - say so instead of lying.
  if (!removed || removed.length === 0) {
    return NextResponse.json(
      {
        error: 'delete_blocked',
        message: 'The database refused the delete. Re-run supabase/schema.sql so the posts delete policy exists, then try again.',
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, id });
}

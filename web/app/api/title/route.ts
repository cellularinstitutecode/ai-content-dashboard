// web/app/api/title/route.ts
// "Write the title" — from what the speaker said and what the post says.
//
// The composer had two ways to get a title and both were guesses from outside
// the video: the file's name (which names whoever shot it) and, later, the
// keyword search (which is a search-volume ranking, not a description). This is
// the third and the one that was asked for — the transcript and the copy, read
// by the model that wrote the copy in the first place.
//
// It only ever SUGGESTS. The answer goes through lib/post-title.ts like a title
// typed by a person: a name from the strip list is refused, the clinic's name is
// added once, and an unusable answer falls back to the rung below rather than
// reaching a channel.
import { NextRequest, NextResponse } from 'next/server';
import { isAllowedEmail } from '@/lib/access';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { checkRateLimit } from '@/lib/rate-limit';
import { writeTitle } from '@/lib/ai';
import { professionalTitle } from '@/lib/post-title';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// One short model call with one retry. Well inside the platform default, but
// declared rather than assumed — the same lesson the schedule route paid for.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let userId = '';
  try {
    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!isAllowedEmail(user.email)) {
      return NextResponse.json({ error: 'forbidden', message: 'This account is not authorized for this workspace.' }, { status: 403 });
    }
    userId = user.id;
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const rl = await checkRateLimit(userId, 'title');
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
  }

  const payload = await req.json().catch(() => ({} as Record<string, unknown>));
  const copy = typeof payload.text === 'string' ? payload.text : '';
  const draftId = typeof payload.draftId === 'string' ? payload.draftId.trim() : '';

  // THE TRANSCRIPT, when this post came from a video.
  //
  // The draft's pack carries an excerpt of the words that were actually spoken
  // (lib/video-prepare.ts KEPT_TRANSCRIPT), which is what makes this title
  // different from one written off the caption alone. Read with the caller's
  // own session so a draft id cannot be used to read somebody else's row.
  let transcript = '';
  let subject = '';
  if (draftId) {
    try {
      const admin = supabaseAdmin();
      const { data } = await admin.from('drafts').select('pack').eq('id', draftId).eq('user_id', userId).maybeSingle();
      const pack = ((data as { pack?: Record<string, unknown> | null } | null)?.pack || {}) as Record<string, unknown>;
      if (typeof pack.transcript === 'string') transcript = pack.transcript;
      if (typeof pack.title === 'string') subject = pack.title;
    } catch (e) {
      // A title is still worth writing from the copy alone.
      reportError('title:draft-read', e, { draftId });
    }
  }

  if (!copy.trim() && !transcript.trim()) {
    return NextResponse.json(
      { error: 'nothing_to_read', message: 'Write the post first — the title is written from what it says and from the video’s transcript.' },
      { status: 400 },
    );
  }

  const drafted = await writeTitle({ copy, transcript, subject });
  if (!drafted) {
    return NextResponse.json(
      { error: 'no_title', message: 'The writer did not answer with a usable title just now. Try again, or type one.' },
      { status: 502 },
    );
  }
  // Through the same door a typed title goes through: names refused, the
  // clinic's name added once, nothing absurd allowed near a channel.
  const out = professionalTitle({ drafted });
  return NextResponse.json({ title: out.title, source: out.source, fromTranscript: Boolean(transcript.trim()) });
}

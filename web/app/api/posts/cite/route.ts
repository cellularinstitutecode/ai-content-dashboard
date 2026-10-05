// POST /api/posts/cite  { text, title? } → { text, ref, outcome, note }
//
// "Find and add the citation" on the composer: copy pasted or handed over
// from the video sheet that the send door refuses for want of a REF line.
// The person's words are kept; the AVISO line and a researched, verified REF
// line are appended (lib/existing-copy-cite.ts). Nothing is saved or sent:
// the composer shows the result and Send is live when the door agrees.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { citeExistingCopy } from '@/lib/existing-copy-cite';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// The research climbs the same ladder as Verify / fix; a minute is its cap.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'video-prepare');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit, message: 'Too many requests this hour. Try again in a little while.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
  const body = await req.json().catch(() => ({}));
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 8000) : '';
  if (!text) return NextResponse.json({ error: 'bad_request', message: 'Write the post first.' }, { status: 400 });
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 300) : '';
  try {
    const out = await citeExistingCopy({ userId: auth.userId, text, title, budgetMs: 90_000 });
    return NextResponse.json({ text: out.text, ref: out.ref, outcome: out.outcome, note: out.note }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    reportError('posts:cite', e);
    return NextResponse.json({ error: 'cite_failed', message: 'The citation could not be found just now. Nothing was changed — try again in a moment.' }, { status: 502 });
  }
}

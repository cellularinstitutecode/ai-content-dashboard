// GET /api/library/index
//
// The Image Library reads itself. Every twenty minutes (vercel.json) this
// reads up to thirty photographs of the team's Drive folder that the index
// does not have yet (lib/library-index.ts) — what each shows, its colour —
// so posts can be given the clinic's own photographs without anybody
// pressing "Read the library" on the Image Library page. That button stays,
// for a person who wants the folder read now.
//
// It answers at once, and reads nothing, when Drive or OpenAI is not set up,
// when the library_photos table has not been created yet (the health check
// names the migration), or when every photograph is already read.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { sourcesConfigured } from '@/lib/google-sources';
import { indexLibrary, libraryIndexStatus, libraryTableReady } from '@/lib/library-index';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** How many photographs one pass reads at most; a 175-photo folder is done in about two hours. */
const PER_PASS = 30;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') || '';
  const isCron = Boolean(secret) && auth === 'Bearer ' + secret;
  if (!isCron) {
    // Not the cron: a person. Allowlist, as every route that spends OpenAI credit.
    const session = await requireAllowlistedUser();
    if (!session.ok) return session.response;
  }
  if (!sourcesConfigured() || !process.env.OPENAI_API_KEY) return NextResponse.json({ ok: true, skipped: 'not_configured' });
  if (!(await libraryTableReady())) return NextResponse.json({ ok: true, skipped: 'no_table', note: 'Run supabase/library-photos.sql once; the health check names it.' });
  try {
    const before = await libraryIndexStatus();
    if (before.total > 0 && before.indexed >= before.total) return NextResponse.json({ ok: true, skipped: 'all_read', ...before });
    const report = await indexLibrary({ max: PER_PASS, budgetMs: 270_000 });
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    reportError('library-index:cron', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

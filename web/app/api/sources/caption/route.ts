// GET /api/sources/caption
//
// Reads the team's Drive photo folder with the vision model and REMEMBERS what
// is in it (lib/library-index.ts, table library_photos): what each photograph
// shows, what the cover rules would refuse it for, and its colour against the
// house palette — so posts can be given the clinic's own photographs instead
// of paying for generated ones.
//
//   ?status=1          how much of the folder is indexed (reads nothing new)
//   ?limit=N           index up to N photographs not yet read (default 25)
//   ?refresh=1         read them again even if indexed
//
// The report also carries the inventory by pillar, as it always did.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { sourcesConfigured } from '@/lib/google-sources';
import { PILLARS } from '@/lib/content-strategy';
import { coverSafe, inventory, pillarsFor, type Caption } from '@/lib/library-caption';
import { indexLibrary, libraryIndexStatus, loadLibraryRows } from '@/lib/library-index';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const gate = await requireAllowlistedUser();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!sourcesConfigured()) return NextResponse.json({ error: 'sources_not_configured' }, { status: 503 });

  const url = new URL(req.url);
  if (url.searchParams.get('status')) return NextResponse.json(await libraryIndexStatus());
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: 'no_openai_key' }, { status: 503 });
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 25));
  const refresh = Boolean(url.searchParams.get('refresh'));

  try {
    const report = await indexLibrary({ max: limit, budgetMs: 270_000, refresh });
    const rows = await loadLibraryRows();
    const caps: Caption[] = rows.map((r) => ({ caption: r.caption, subjects: r.subjects as Caption['subjects'], blockers: r.blockers as Caption['blockers'] }));
    return NextResponse.json({
      ...report,
      indexed: rows.length,
      inventory: inventory(caps, PILLARS.map((p) => p.id)),
      rows: rows.map((r) => {
        const c = { caption: r.caption, subjects: r.subjects as Caption['subjects'], blockers: r.blockers as Caption['blockers'] };
        const safe = coverSafe(c);
        return { id: r.file_id, name: r.name, caption: r.caption, subjects: r.subjects, blockers: r.blockers, pillars: pillarsFor(c), coverSafe: safe.ok, needsConsent: safe.needsConsent, measured: Boolean(r.stats), used: r.used_count, lastUsedAt: r.last_used_at };
      }),
    });
  } catch (e) {
    reportError('sources-caption', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

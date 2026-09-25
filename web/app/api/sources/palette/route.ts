// GET /api/sources/palette
//
// Measures the team's Drive photo folder against the house palette and returns
// the triage: which photographs are already in it, which a grade brings in, and
// which are past what a grade can honestly do.
//
// Read-only. Nothing is written, nothing is imported, no photograph is changed.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { downloadDriveFile, listFolderImages, sourcesConfigured } from '@/lib/google-sources';

// The camera exports in the folder run 30-45 MB. Both of these routes scale the
// picture down before they look at it, so the only thing the ceiling has to do
// here is refuse something pathological.
const BIG_FILE_MAX_BYTES = 64 * 1024 * 1024;
import { measureImage } from '@/lib/palette-measure';
import { BRAND_TARGET, gradeFor } from '@/lib/palette';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const gate = await requireAllowlistedUser();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!sourcesConfigured()) return NextResponse.json({ error: 'sources_not_configured' }, { status: 503 });

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    const all = await listFolderImages();
    const slice = all.slice(offset, offset + limit);
    const rows: Array<Record<string, unknown>> = [];
    for (const f of slice) {
      try {
        const file = await downloadDriveFile(f.id, BIG_FILE_MAX_BYTES);
        const ext = /png$/i.test(file.contentType) ? 'png' : /webp$/i.test(file.contentType) ? 'webp' : 'jpg';
        const stats = await measureImage(file.bytes, ext);
        if (!stats) { rows.push({ id: f.id, name: f.name, verdict: 'unreadable' }); continue; }
        const g = gradeFor(stats);
        rows.push({ id: f.id, name: f.name, stats, verdict: g.verdict, reason: g.reason, distance: g.distance, filters: g.filters });
      } catch (e) {
        reportError('sources-palette:one', e);
        rows.push({ id: f.id, name: f.name, verdict: 'unreadable' });
      }
    }
    const count = (v: string) => rows.filter((r) => r.verdict === v).length;
    return NextResponse.json({
      target: BRAND_TARGET,
      total: all.length,
      measured: rows.length,
      offset,
      summary: { ready: count('ready'), grade: count('grade'), outside: count('outside'), unreadable: count('unreadable') },
      rows,
    });
  } catch (e) {
    reportError('sources-palette', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

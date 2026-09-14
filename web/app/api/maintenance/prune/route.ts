// web/app/api/maintenance/prune/route.ts
// The nightly sweep that keeps the database and the image bucket from filling.
//
// Nothing in this app ever deleted anything: three crons, no retention, every
// byte ever written still there — until the project hit its storage allowance.
// This is the fourth cron. It removes exactly three kinds of thing, each of
// which nothing can ever read again:
//
//   1. usage_events older than a day. Every rate-limit window in lib/rate-limit.ts
//      is one hour; a day is 24× the longest anything reads.
//   2. semrush_usage older than last month. lib/semrush.ts sums only the current
//      calendar month; keeping last month as well is twice what it can ask for.
//   3. Objects in the image bucket that no draft references and that are older
//      than a week. lib/storage-prune.ts is the rule; see its header.
//
// SHIPPED WITH DELETES OFF. Until MAINTENANCE_PRUNE=on is set, every run is a
// dry run: it counts, it lists a sample, it reports, and it removes nothing.
// Read one night's report, then switch it on. A dry run and a live run produce
// the same report, so what you saw is what will go.
//
// Called two ways, like the Autopilot tick:
//   - Vercel Cron (see vercel.json) with Authorization: Bearer CRON_SECRET.
//   - A signed-in, allowlisted person, for a report on demand.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { IMAGE_BUCKET } from '@/lib/images';
import { ORPHAN_FLOOR_MS, orphanObjects, referencedKeys, totalBytes, type StoredObject } from '@/lib/storage-prune';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** 24 hours: 24× the longest rate-limit window. */
const USAGE_EVENTS_KEEP_MS = 24 * 60 * 60 * 1000;
/** Storage lists at most this many per call. */
const LIST_PAGE = 1000;
/** Draft packs are read this many at a time, well under PostgREST's cap. */
const DRAFT_PAGE = 500;
/** Storage removes take this many keys per call. */
const REMOVE_BATCH = 100;
/** An upper bound on objects removed per night, so a run always finishes. */
const MAX_REMOVE_PER_RUN = 2000;

export function pruneEnabled(): boolean {
  return String(process.env.MAINTENANCE_PRUNE || '').toLowerCase() === 'on';
}

/** The first instant of LAST month, UTC — everything before it is unread by lib/semrush.ts. */
export function semrushKeepFrom(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString();
}

type TablePrune = { table: string; before: string; stale: number | null; deleted: number; error?: string };

type StorageReport = {
  bucket: string;
  objects: number;
  bytes: number;
  drafts: number;
  referenced: number;
  orphans: number;
  orphanBytes: number;
  deleted: number;
  sample: { key: string; size: number | null; createdAt: string | null }[];
  error?: string;
};

async function pruneTable(table: string, before: string, live: boolean): Promise<TablePrune> {
  const admin = supabaseAdmin();
  const out: TablePrune = { table, before, stale: null, deleted: 0 };
  const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).lt('created_at', before);
  if (error) return { ...out, error: error.message };
  out.stale = count ?? 0;
  if (!live || !out.stale) return out;
  const { count: removed, error: delError } = await admin.from(table).delete({ count: 'exact' }).lt('created_at', before);
  if (delError) return { ...out, error: delError.message };
  out.deleted = removed ?? 0;
  return out;
}

/** Every object under packs/, or null when the listing could not be trusted. */
async function listPackObjects(): Promise<StoredObject[] | null> {
  const admin = supabaseAdmin();
  const all: StoredObject[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await admin.storage
      .from(IMAGE_BUCKET)
      .list('packs', { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) {
      reportError('maintenance:list', error, { offset });
      return null;
    }
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
      // A folder placeholder has no id; skip anything that is not a file.
      if (!r || typeof r.name !== 'string' || !(r as { id?: string }).id) continue;
      const meta = (r as { metadata?: { size?: number } | null }).metadata;
      all.push({ name: r.name, createdAt: (r as { created_at?: string }).created_at ?? null, size: meta?.size ?? null });
    }
    if (rows.length < LIST_PAGE) break;
  }
  return all;
}

/**
 * Every draft's pack, or null when the read could not be trusted.
 *
 * Fails CLOSED. PostgREST caps a page and a capped read does not error — it
 * returns FEWER packs, which would make more objects look unreferenced than
 * are. The exact count is asked for alongside the rows and any shortfall means
 * "delete nothing tonight".
 */
async function readAllPacks(): Promise<unknown[] | null> {
  const admin = supabaseAdmin();
  const packs: unknown[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from += DRAFT_PAGE) {
    const { data, error, count } = await admin
      .from('drafts')
      .select('pack', { count: 'exact' })
      .order('id', { ascending: true })
      .range(from, from + DRAFT_PAGE - 1);
    if (error) {
      reportError('maintenance:packs', error, { from });
      return null;
    }
    if (expected == null) expected = typeof count === 'number' ? count : null;
    const rows = (data as { pack?: unknown }[] | null) ?? [];
    for (const r of rows) packs.push(r?.pack ?? null);
    if (rows.length < DRAFT_PAGE) break;
  }
  if (expected == null || packs.length !== expected) {
    reportError('maintenance:packs', new Error('draft count mismatch'), { read: packs.length, expected: expected ?? -1 });
    return null;
  }
  return packs;
}

async function pruneStorage(live: boolean, now: number): Promise<StorageReport> {
  const report: StorageReport = {
    bucket: IMAGE_BUCKET, objects: 0, bytes: 0, drafts: 0, referenced: 0, orphans: 0, orphanBytes: 0, deleted: 0, sample: [],
  };
  const objects = await listPackObjects();
  if (!objects) return { ...report, error: 'the bucket could not be listed — nothing was touched' };
  report.objects = objects.length;
  report.bytes = totalBytes(objects);

  const packs = await readAllPacks();
  if (!packs) return { ...report, error: 'the drafts could not all be read — nothing was touched' };
  report.drafts = packs.length;

  const referenced = referencedKeys(packs, IMAGE_BUCKET);
  report.referenced = referenced.size;
  const keyOf = (o: StoredObject) => 'packs/' + o.name;
  const orphans = orphanObjects(objects, referenced, keyOf, now, ORPHAN_FLOOR_MS);
  report.orphans = orphans.length;
  report.orphanBytes = totalBytes(orphans);
  report.sample = orphans.slice(0, 20).map((o) => ({ key: keyOf(o), size: o.size ?? null, createdAt: o.createdAt ?? null }));
  if (!live || !orphans.length) return report;

  const admin = supabaseAdmin();
  const keys = orphans.slice(0, MAX_REMOVE_PER_RUN).map(keyOf);
  for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
    const batch = keys.slice(i, i + REMOVE_BATCH);
    const { data, error } = await admin.storage.from(IMAGE_BUCKET).remove(batch);
    if (error) {
      reportError('maintenance:remove', error, { batch: batch.length });
      report.error = 'some objects could not be removed: ' + error.message;
      break;
    }
    report.deleted += Array.isArray(data) ? data.length : batch.length;
  }
  return report;
}

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') || '';
  const isCron = Boolean(secret) && auth === 'Bearer ' + secret;
  if (!isCron) {
    const session = await requireAllowlistedUser();
    if (!session.ok) return session.response;
    const rl = await checkRateLimit(session.userId, 'maintenance-prune');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }
  }

  const live = pruneEnabled();
  const now = new Date();
  try {
    const usageEvents = await pruneTable('usage_events', new Date(now.getTime() - USAGE_EVENTS_KEEP_MS).toISOString(), live);
    const semrushUsage = await pruneTable('semrush_usage', semrushKeepFrom(now), live);
    const storage = await pruneStorage(live, now.getTime());
    const report = {
      ok: true,
      live,
      note: live
        ? 'Deletes are ON (MAINTENANCE_PRUNE=on).'
        : 'DRY RUN — nothing was deleted. Set MAINTENANCE_PRUNE=on to act on this report.',
      at: now.toISOString(),
      usageEvents,
      semrushUsage,
      storage,
    };
    // The cron dashboard shows logs, not bodies. Say it there too.
    console.log('maintenance:prune', JSON.stringify(report));
    return NextResponse.json(report);
  } catch (e) {
    reportError('maintenance:prune', e);
    return NextResponse.json(
      { ok: false, error: 'prune_failed', message: e instanceof Error ? e.message : 'The sweep failed' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

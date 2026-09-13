// web/lib/video-register.ts
// Writing to the video register, and reading it back.
//
// Three properties, and they are the whole design. Any change that loses one of
// them turns a record-keeping feature into a way to break preparing a video.
//
//  1. IT NEVER GATES ANYTHING. Every write is fire-and-forget and returns a
//     boolean; nothing here throws. This is the discipline lib/approval-log.ts
//     already uses, for the same reason: the thing being recorded has already
//     happened, so the record is evidence, not a checkpoint.
//
//  2. IT NO-OPS WHEN THE TABLE IS ABSENT. supabase/video-register.sql is pasted
//     in by hand like every migration here, so the code has to ship before the
//     table exists. The first PostgREST "relation does not exist" is remembered
//     and every later write returns immediately — no retry storm, no error spam,
//     and the app behaves exactly as it did before.
//
//  3. IT IS APPEND-ONLY. Inserts only. Nothing in this module updates or deletes
//     a row, and the migration revokes both from `authenticated` so that is a
//     property of the database and not a promise made here.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';
import { registerEntry, type VideoActor, type VideoEvent } from '@/lib/video-event';

const TABLE = 'video_register';

/**
 * Has the table been created yet?
 *
 * null = not asked. false = confirmed missing, stop trying. Only ever set false
 * by a relation-does-not-exist, never by a transient failure: a network blip
 * must not silently retire the register for the life of the container.
 */
let tableExists: boolean | null = null;

/** PostgREST's codes for "that relation is not there". */
function isMissingTable(err: unknown): boolean {
  const e = (err || {}) as { code?: string; message?: string };
  if (e.code === '42P01' || e.code === 'PGRST205') return true;
  return /schema cache|does not exist|could not find the table/i.test(String(e.message || ''));
}

/** True when the register is switched off because its table has not been created. */
export function registerIsOff(): boolean {
  return tableExists === false;
}

type EventInput = {
  userId: string;
  videoKey: string;
  event: VideoEvent;
  actor: VideoActor;
  title?: unknown;
  link?: unknown;
  detail?: Record<string, unknown> | null;
};

/**
 * Record one thing that happened. Never throws.
 *
 * @returns true only when a row was actually written, so a caller that wants to
 *   say "this is in the register" can check rather than assume.
 */
export async function recordVideoEvent(input: EventInput): Promise<boolean> {
  if (tableExists === false) return false;
  if (!input.userId || !input.videoKey) return false;

  const row = registerEntry(input);
  // supabase-js RESOLVES a failed insert rather than rejecting it, which has
  // bitten this codebase more than any other single thing — so the error is
  // read, not inferred from the absence of a throw.
  const { error } = await supabaseAdmin()
    .from(TABLE)
    .insert(row)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));

  if (!error) {
    tableExists = true;
    return true;
  }
  if (isMissingTable(error)) {
    // Said once and only once: every later call returns at the guard above, so
    // no `if` is needed here — reaching this line means the register was still
    // believed to be on.
    console.warn(
      'video-register: the video_register table does not exist, so the register is off. ' +
      'Run web/supabase/video-register.sql in the Supabase SQL editor to switch it on. ' +
      'Nothing else is affected.',
    );
    tableExists = false;
    return false;
  }
  reportError('video-register:insert', error, { event: row.event, actor: row.actor });
  return false;
}

/**
 * Record the arrival of rows the sweep has just walked past. Never throws.
 *
 * Bulk and idempotent: `first_seen` carries a partial unique index on
 * video_key, so re-running the sweep inserts nothing rather than duplicating
 * every row every night. One statement per sweep, not one per row.
 *
 * @returns how many were genuinely new.
 */
export async function recordFirstSeen(
  userId: string,
  seen: readonly { videoKey: string; title?: unknown; link?: unknown; tab?: string; row?: number | null }[],
  actor: VideoActor = 'sweep',
): Promise<number> {
  if (tableExists === false) return 0;
  if (!userId || !seen.length) return 0;

  // Deduplicated in memory first. The same video can legitimately appear twice
  // in one sweep (the same title and link pasted into two tabs produces two
  // different keys, but the same key twice would make Postgres reject the whole
  // statement rather than ignore the duplicate).
  const byKey = new Map<string, (typeof seen)[number]>();
  for (const s of seen) if (s.videoKey && !byKey.has(s.videoKey)) byKey.set(s.videoKey, s);

  const keys = [...byKey.keys()];

  // WHICH OF THESE ARE NEW — read first, then insert the difference.
  //
  // Not an upsert with onConflict. The uniqueness that makes this idempotent is
  // a PARTIAL index (`where event = 'first_seen'`), and Postgres will only infer
  // a partial index when the statement repeats its predicate in the ON CONFLICT
  // clause — which PostgREST cannot emit, so `onConflict: 'video_key'` fails
  // outright with 42P10. The index is still the right constraint; it is the race
  // guard behind this read, not a substitute for it.
  const known = await supabaseAdmin()
    .from(TABLE)
    .select('video_key')
    .eq('user_id', userId)
    .eq('event', 'first_seen')
    .in('video_key', keys)
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { code?: string; message?: string } }));

  if (known.error) {
    if (isMissingTable(known.error)) {
      tableExists = false;
      return 0;
    }
    // Not knowing which are new is not a licence to insert them all again.
    reportError('video-register:first-seen-read', known.error, { count: String(keys.length) });
    return 0;
  }
  tableExists = true;

  const seenAlready = new Set((known.data || []).map((r: { video_key?: string }) => String(r.video_key || '')));
  const fresh = keys.filter((k) => !seenAlready.has(k));
  if (!fresh.length) return 0;

  const rows = fresh.map((k) => {
    const s = byKey.get(k)!;
    return registerEntry({
      userId,
      videoKey: k,
      event: 'first_seen',
      actor,
      title: s.title,
      link: s.link,
      detail: { tab: s.tab, row: typeof s.row === 'number' ? s.row : undefined },
    });
  });

  const { error } = await supabaseAdmin()
    .from(TABLE)
    .insert(rows)
    .then((x) => x, (e: unknown) => ({ error: e as { code?: string; message?: string } }));

  if (error) {
    // 23505 is the partial unique index doing its job: a concurrent sweep
    // registered the same video between the read above and this insert. That is
    // the index working, not a failure, and it must not be reported as one.
    if (String((error as { code?: string }).code) === '23505') return 0;
    if (isMissingTable(error)) {
      tableExists = false;
      return 0;
    }
    reportError('video-register:first-seen', error, { count: String(rows.length) });
    return 0;
  }
  return rows.length;
}

export type RegisterRow = {
  id: string;
  videoKey: string;
  title: string | null;
  link: string | null;
  event: string;
  actor: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

function shape(r: Record<string, any>): RegisterRow {
  return {
    id: String(r.id),
    videoKey: String(r.video_key || ''),
    title: r.title ?? null,
    link: r.link ?? null,
    event: String(r.event || ''),
    actor: String(r.actor || 'unknown'),
    detail: (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, unknown>,
    createdAt: String(r.created_at || ''),
  };
}

/**
 * The register, newest first. Throws on a failed read, `off` when there is no table.
 *
 * Thrown rather than swallowed, for the reason listRuns throws: "you have no
 * history" and "I could not read your history" send a person to opposite places,
 * and the second one silently becomes the first.
 */
export async function readRegister(
  userId: string,
  opts: { limit?: number; videoKey?: string } = {},
): Promise<{ off: true } | { off: false; rows: RegisterRow[] }> {
  if (tableExists === false) return { off: true };

  let q = supabaseAdmin()
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200));
  if (opts.videoKey) q = q.eq('video_key', opts.videoKey);

  const { data, error } = await q.then((x) => x, (e: unknown) => ({ data: null, error: e as { code?: string } }));
  if (error) {
    if (isMissingTable(error)) {
      tableExists = false;
      return { off: true };
    }
    throw new Error('The video register could not be read.');
  }
  tableExists = true;
  return { off: false, rows: (data || []).map(shape) };
}

// web/lib/video-revive.ts
// Put back into the queue the rows that stopped for reasons that have passed.
//
// Two things used to strand a video permanently, and neither said so anywhere:
//
//  1. A run that died mid-flight left its row claimed — `state: 'preparing'`.
//     The sweep is right to skip a live claim, and right to treat one older
//     than CLAIM_TTL_MS as stale, but the row sat there in the meantime with
//     no screen anywhere reporting it and its attempt already spent.
//  2. A row that failed its allowance was retired for good. Nothing in the
//     codebase could reset `attempts`, so "the clock was bad that week" and
//     "this video cannot be read" had the same permanent ending.
//
// This runs once at the top of a sweep, before any tab is read, and costs one
// query. It never transcribes and never spends: it only decides which rows the
// sweep that follows is allowed to look at.
import 'server-only';

import { reviveDecision, type ReviveRow } from '@/lib/revive-decision';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type ReviveResult = {
  /** Claims from runs that died mid-flight, handed back to the queue. */
  released: number;
  /** Retired rows given another go because their failure looked temporary. */
  revived: number;
  /** Rows left alone on purpose, because trying again cannot help them. */
  needsHuman: number;
};

/**
 * Hand stalled rows back to the queue. Reads one page, writes only what moved.
 *
 * Bounded on purpose: a sweep that spent its whole budget reviving would never
 * reach the videos it revived.
 */
export async function reviveStalledRuns(userId: string, now = Date.now(), limit = 50): Promise<ReviveResult> {
  const out: ReviveResult = { released: 0, revived: 0, needsHuman: 0 };
  const admin = supabaseAdmin();

  // '*' rather than a column list: `last_error_code` and `revivals` arrived
  // after the first version of this table, and naming a column a database does
  // not have refuses the whole query. Reviving nothing is a safe degradation;
  // failing to read is not worth an exception here.
  const { data, error } = await admin
    .from('video_runs')
    .select('*')
    .eq('user_id', userId)
    .in('state', ['preparing', 'failed', 'needs_transcript'])
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    reportError('video-revive:read', error);
    return out;
  }

  for (const row of (data || []) as (ReviveRow & { id: string })[]) {
    const decision = reviveDecision(row, now);
    if (decision === 'leave') continue;
    if (decision === 'needs_human') { out.needsHuman++; continue; }

    const patch: Record<string, unknown> = {
      state: 'discovered',
      last_error: null,
      updated_at: new Date(now).toISOString(),
    };
    if (decision === 'release') {
      // The attempt this claim consumed is given back — the same refund the
      // clock-stop path already makes, and for the same reason.
      patch.attempts = Math.max(0, (row.attempts ?? 1) - 1);
      out.released++;
    } else {
      patch.attempts = 0;
      patch.last_error_code = null;
      patch.revivals = (row.revivals ?? 0) + 1;
      out.revived++;
    }

    const { error: writeError } = await admin.from('video_runs').update(patch).eq('id', row.id);
    if (writeError) {
      // A database without `revivals` refuses the whole update, which would
      // silently undo the count above. Try again without the new field rather
      // than report a revival that did not happen.
      const fallback = { ...patch };
      delete fallback.revivals;
      delete fallback.last_error_code;
      const { error: retryError } = await admin.from('video_runs').update(fallback).eq('id', row.id);
      if (retryError) {
        reportError('video-revive:write', retryError, { id: row.id });
        if (decision === 'release') out.released--; else out.revived--;
      }
    }
  }

  return out;
}

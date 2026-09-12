// web/lib/video-runs.ts
// Reading and re-arming the video pipeline's own record of itself.
//
// `video_runs` has always known more than any screen: which rows failed, how
// many times, with what error, when, and what reached Metricool. No HTTP route
// ever read it, so the only visible state was a Spanish string in the sheet's
// ESTADO IA column and the answer to "what happened to that video?" was to
// scroll and guess.
//
// Both the /api/videos/runs route and the assistant's tools go through here.
// The assistant deliberately does NOT call its own API over HTTP: a serverless
// self-fetch needs an absolute URL and forwards no cookies, so it would 401 in
// production while working perfectly in development.
import 'server-only';

import { SOURCE_IDS } from '@/lib/google-sources';
import { rowKeyFor } from '@/lib/video-row';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';
// The canonical Drive-link parser. A hand-rolled regex lived here instead, with
// no host check and a looser id pattern — and because the WRITER side keys the
// public-copy cache by this function, any disagreement between the two showed a
// video that has a shareable copy as one that does not.
import { parseDriveFileId } from '@/lib/drive-url';

// Every read below selects '*' rather than a column list. `last_error_code`
// and `revivals` arrived after the first version of this table, and naming a
// column the database does not have refuses the WHOLE query — while
// supabase-js RESOLVES a refused query. A deployment that had not run the
// migration would therefore read "no rows" and the assistant would cheerfully
// report an empty, healthy pipeline. Reading one column too many is harmless;
// reading nothing and calling it good is not.

/** How far back "recent" reaches for the first half of the merge below. */
const RECENT_MS = 24 * 60 * 60 * 1000;

/** The states that mean somebody or something still owes this row work. */
const OPEN_STATES = ['failed', 'needs_transcript', 'preparing', 'discovered'];

export type VideoRun = {
  id: string;
  tab: string | null;
  row_key: string;
  row_number: number | null;
  video_title: string | null;
  video_link: string | null;
  state: string | null;
  attempts: number | null;
  last_error: string | null;
  last_error_code?: string | null;
  revivals?: number | null;
  draft_id: string | null;
  transcript_source: string | null;
  keywords: string | null;
  ref: string | null;
  /**
   * What actually reached Metricool for this row, keyed by network.
   *
   * Declared here at last: the column has existed since video-autopilot.sql and
   * the schema probe checks for it, but the type did not mention it, so the one
   * record of "has this already been queued?" was invisible to every caller.
   */
  metricool?: Record<string, unknown> | null;
  updated_at: string | null;
};

/**
 * The rows worth looking at: everything recent, PLUS everything still open
 * however old it is.
 *
 * The second half is the point. A row that stopped being touched three weeks
 * ago sits in the past by definition, so a plain "last 24 hours" query renders
 * "needs attention" permanently empty — which is exactly the complaint. The
 * same two-query merge is why the Autopilot queue can show a stalled run.
 */
export async function listRuns(userId: string, limit = 60): Promise<VideoRun[]> {
  const admin = supabaseAdmin();
  const since = new Date(Date.now() - RECENT_MS).toISOString();

  const [recent, open] = await Promise.all([
    admin.from('video_runs').select('*').eq('user_id', userId)
      .gte('updated_at', since).order('updated_at', { ascending: false }).limit(limit),
    admin.from('video_runs').select('*').eq('user_id', userId)
      .in('state', OPEN_STATES).order('updated_at', { ascending: false }).limit(limit),
  ]);

  if (recent.error && open.error) {
    // Both halves failed: this is a real outage, not an empty pipeline, and
    // saying "nothing to report" here is how a broken read looks like good news.
    reportError('video-runs:list', recent.error);
    throw new Error('The video pipeline records could not be read.');
  }
  if (recent.error) reportError('video-runs:list-recent', recent.error);
  if (open.error) reportError('video-runs:list-open', open.error);

  const byId = new Map<string, VideoRun>();
  for (const r of [...(recent.data || []), ...(open.data || [])] as VideoRun[]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

/** One row, by its id or by the content-derived key the sweep uses. */
export async function getRun(userId: string, ref: string): Promise<VideoRun | null> {
  const admin = supabaseAdmin();
  const key = String(ref || '').trim();
  if (!key) return null;

  // A uuid is an id; anything else is a row_key. Guessing wrong costs one query.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const { data, error } = await admin.from('video_runs').select('*')
    .eq('user_id', userId).eq(isUuid ? 'id' : 'row_key', key).maybeSingle();
  if (error) { reportError('video-runs:get', error); return null; }
  return (data as VideoRun) || null;
}

/**
 * Hand a row back to the queue, whatever state it stopped in.
 *
 * This is the reset that did not exist. The sweep retires a row once its
 * attempts are spent and nothing anywhere could undo that — so a video stopped
 * by a bad afternoon was stopped for the life of the deployment. Clearing the
 * count is what makes "retry it" mean anything.
 */
export async function rearmRun(userId: string, id: string): Promise<boolean> {
  const admin = supabaseAdmin();
  const patch: Record<string, unknown> = {
    state: 'discovered',
    attempts: 0,
    last_error: null,
    last_error_code: null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from('video_runs').update(patch).eq('user_id', userId).eq('id', id);
  if (!error) return true;

  // A database that predates last_error_code refuses the whole statement,
  // which would leave the attempts count exactly where it was while the caller
  // reported a successful retry.
  const fallback = { ...patch };
  delete fallback.last_error_code;
  const { error: retry } = await admin.from('video_runs').update(fallback).eq('user_id', userId).eq('id', id);
  if (retry) { reportError('video-runs:rearm', retry, { id }); return false; }
  return true;
}

/**
 * Put the failure back after a retry that did not work.
 *
 * `rearmRun` clears `last_error` and the attempt count — that is its job. But
 * a retry that then fails would leave the row looking brand new: the evidence
 * erased, the assistant reporting nothing wrong, and the next sweep starting
 * the whole download again as though it had never been tried. The clearing
 * only stands if the retry succeeds.
 */
export async function recordRunFailure(
  userId: string,
  id: string,
  message: string,
  code: string,
  needsPaste: boolean,
): Promise<void> {
  const admin = supabaseAdmin();
  const patch: Record<string, unknown> = {
    state: needsPaste ? 'needs_transcript' : 'failed',
    attempts: 1,
    last_error: message,
    last_error_code: code,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from('video_runs').update(patch).eq('user_id', userId).eq('id', id);
  if (!error) return;
  const fallback = { ...patch };
  delete fallback.last_error_code;
  const { error: retry } = await admin.from('video_runs').update(fallback).eq('user_id', userId).eq('id', id);
  if (retry) reportError('video-runs:record-failure', retry, { id });
}

/**
 * Record a failure that happened at the BUTTON, not in the sweep.
 *
 * `video_runs` was only ever written on the success path, inside completeRow.
 * So a Prepare that failed — one row or a whole batch — left no trace anywhere
 * except a note in that browser's localStorage. The consequences all showed up
 * at once: the assistant reported a healthy pipeline while two videos were
 * broken, /api/videos/runs could not see them, the overnight pass had no row to
 * revive, and the only way to find out what went wrong was to press the button
 * again and watch.
 *
 * Keyed exactly as the success path keys it. rowKeyFor uses the LINK when there
 * is one and falls back to the file name, and completeRow passes the same link
 * this route was given — so this updates the sweep's own row rather than
 * creating a second one beside it.
 */
export async function recordRowFailure(opts: {
  userId: string;
  tab: string;
  row: number;
  /** The link Prepare was given; the same one completeRow keys its row on. */
  videoLink: string;
  title: string | null;
  message: string;
  /** prepareVideo's own error code, which lib/failure-kind.ts classifies. */
  code: string;
  /** True when only a pasted transcript can move this on. */
  needsPaste: boolean;
  spreadsheetId?: string;
}): Promise<void> {
  const admin = supabaseAdmin();
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  if (!spreadsheetId || !opts.tab || !Number.isInteger(opts.row)) return;
  const rowKey = rowKeyFor(opts.title || '', opts.videoLink);

  // Read the attempt count first rather than upserting over it. A row the sweep
  // has already tried twice must not be reset to one by a person pressing the
  // button, or the allowance in lib/failure-kind.ts never runs out.
  let attempts = 1;
  try {
    const { data } = await admin.from('video_runs').select('attempts')
      .eq('spreadsheet_id', spreadsheetId).eq('tab', opts.tab).eq('row_key', rowKey).maybeSingle();
    const prior = data as { attempts?: number } | null;
    if (prior && typeof prior.attempts === 'number') attempts = prior.attempts + 1;
  } catch { /* no prior row, or unreadable: one attempt is the honest floor */ }

  const record: Record<string, unknown> = {
    user_id: opts.userId,
    spreadsheet_id: spreadsheetId,
    tab: opts.tab,
    row_key: rowKey,
    row_number: opts.row,
    video_title: opts.title || null,
    video_link: opts.videoLink || null,
    state: opts.needsPaste ? 'needs_transcript' : 'failed',
    attempts,
    last_error: opts.message,
    last_error_code: opts.code,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from('video_runs').upsert(record, { onConflict: 'spreadsheet_id,tab,row_key' });
  if (!error) return;
  // A database that predates last_error_code refuses the whole statement, and
  // losing the record entirely is the thing this function exists to prevent.
  const fallback = { ...record };
  delete fallback.last_error_code;
  const { error: retry } = await admin.from('video_runs').upsert(fallback, { onConflict: 'spreadsheet_id,tab,row_key' });
  if (retry) reportError('video-runs:record-row-failure', retry, { tab: opts.tab, row: String(opts.row) });
}

/**
 * Can these videos actually GO anywhere yet, and has anything been queued?
 *
 * Two facts the assistant could never see. "The caption was written" was the
 * whole of what it knew, so "is this one ready to send?" — the question people
 * actually ask — got a confident answer built from the wrong evidence: a row can
 * be perfectly prepared and still be unable to carry its video, because the
 * world-readable Drive copy is what a network fetches and the clinic's own file
 * is private.
 *
 * Never throws. A readiness lookup that fails should cost the detail, not the
 * pipeline listing it decorates.
 */
export async function readinessFor(
  runs: readonly { video_link?: string | null; metricool?: unknown }[],
): Promise<Map<string, boolean>> {
  const ids = new Set<string>();
  for (const r of runs) {
    const id = parseDriveFileId(String(r.video_link || ''));
    if (id) ids.add(id);
  }
  const out = new Map<string, boolean>();
  if (!ids.size) return out;

  const r = await supabaseAdmin()
    .from('video_transcripts')
    .select('video_id, public_copy_url')
    .in('video_id', [...ids])
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (r.error) {
    reportError('video-runs:readiness', r.error);
    return out;
  }
  for (const row of (r.data || []) as { video_id?: string; public_copy_url?: string | null }[]) {
    if (row.video_id) out.set(String(row.video_id), Boolean(String(row.public_copy_url || '').trim()));
  }
  return out;
}


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

import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

/**
 * Every column, rather than a list.
 *
 * `last_error_code` and `revivals` arrived after the first version of this
 * table. Naming a column the database does not have refuses the WHOLE query,
 * and supabase-js RESOLVES a refused query — so a deployment that had not run
 * the migration would read "no rows" and the assistant would cheerfully report
 * an empty, healthy pipeline. Reading a column too many is harmless; reading
 * nothing and calling it good is not.
 */
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

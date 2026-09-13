// web/lib/video-event.ts
// The shape of one entry in the video register, and how to say it out loud.
//
// The register exists because nothing in this app has ever recorded a video
// ARRIVING. The Video Library is a live window onto the Google Sheet, so a row
// appearing there is not an event anything witnesses; and `video_runs`, which is
// the only database record of the pipeline, is keyed
// `unique (spreadsheet_id, tab, row_key)` and upserted in place by five
// different callers. A row that went discovered → preparing → failed →
// discovered → prepared reads afterwards as simply "prepared". Prior errors are
// deliberately nulled on retry. `attempts` is incremented by one caller,
// decremented by two, reset to zero by two more and forced to 1 by another, so
// it is not a count of anything you can reason about.
//
// So: one row per thing that happened, never updated, never deleted.
//
// Pure and import-free on purpose — the test runner strips types and runs this
// file directly, and everything here is a decision about wording or identity
// that is worth pinning down without a database.

/** What happened. Additive: a name is never reused for a different meaning. */
export const VIDEO_EVENTS = [
  /** The row was seen in the sheet for the first time. The moment nothing recorded. */
  'first_seen',
  /** Copy was written and the row completed. */
  'prepared',
  /** The attempt stopped. `detail.reason` carries the code, `detail.error` the sentence. */
  'failed',
  /** A world-readable Drive copy was made, so the video can reach a network. */
  'copy_made',
  /** That copy could not be made. Until the Shared Drive lands, this is the common one. */
  'copy_failed',
  /** One or more Metricool drafts were created for this video. */
  'queued',
  /** Somebody or something put a stopped row back in the queue. */
  'retried',
  /** The row was passed over deliberately — already done, or not a candidate. */
  'skipped',
] as const;

export type VideoEvent = (typeof VIDEO_EVENTS)[number];

/**
 * WHICH MECHANISM did it.
 *
 * The gap this closes: `video_runs.user_id` is the tenant, not the actor. On
 * this single-clinic deployment every path writes the same id, so the nightly
 * sweep, the Prepare button, a batch, the assistant's retry and the revive pass
 * are indistinguishable after the fact. This column is the difference between
 * "a video was prepared" and "the assistant re-prepared a video a person had
 * already given up on".
 */
export const VIDEO_ACTORS = ['sweep', 'button', 'batch', 'assistant', 'revive', 'picker', 'unknown'] as const;

export type VideoActor = (typeof VIDEO_ACTORS)[number];

export type RegisterEntry = {
  user_id: string;
  video_key: string;
  title: string | null;
  link: string | null;
  event: VideoEvent;
  actor: VideoActor;
  detail: Record<string, unknown>;
};

/** Detail is capped so one enormous error cannot bloat the register. */
const MAX_DETAIL_CHARS = 2000;
const MAX_TITLE = 300;

/**
 * The stable identity of a video across everything that can happen to it.
 *
 * Built from the sheet coordinates rather than the Drive file id, because the
 * register has to be able to record a row that has NO usable link yet — that is
 * precisely the row somebody will ask about. `rowKey` is already content-derived
 * (`lib/video-row.ts` `rowKeyFor`), so inserting a row above this one does not
 * change its key, which is the same property `video_runs` relies on.
 */
export function videoKeyFor(spreadsheetId: string, tab: string, rowKey: string): string {
  return [spreadsheetId, tab, rowKey].map((p) => String(p || '').trim()).join('|');
}

/** A key for something that never came from a sheet row — a Drive file on its own. */
export function driveVideoKey(fileId: string): string {
  return 'drive|' + String(fileId || '').trim();
}

function clip(v: unknown, max: number): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Build the row to insert. Total, so a caller cannot half-fill one.
 *
 * Unknown events and actors are coerced rather than rejected: a register that
 * refuses a row it does not recognise records nothing, and recording something
 * imperfect beats recording nothing at all.
 */
export function registerEntry(input: {
  userId: string;
  videoKey: string;
  event: string;
  actor?: string;
  title?: unknown;
  link?: unknown;
  detail?: Record<string, unknown> | null;
}): RegisterEntry {
  const event = (VIDEO_EVENTS as readonly string[]).includes(input.event)
    ? (input.event as VideoEvent)
    : ('skipped' as VideoEvent);
  const actor = (VIDEO_ACTORS as readonly string[]).includes(String(input.actor))
    ? (String(input.actor) as VideoActor)
    : 'unknown';

  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.detail || {})) {
    if (v === undefined || v === null) continue;
    // Strings are clipped; everything else is kept as-is so numbers and booleans
    // stay queryable rather than becoming text.
    detail[k] = typeof v === 'string' ? clip(v, MAX_DETAIL_CHARS) : v;
  }

  return {
    user_id: String(input.userId || ''),
    video_key: String(input.videoKey || ''),
    title: clip(input.title, MAX_TITLE),
    link: clip(input.link, 2000),
    event,
    actor,
    detail,
  };
}

const ACTOR_WORDS: Record<VideoActor, string> = {
  sweep: 'the nightly pass',
  button: 'someone here',
  batch: 'a batch from this dashboard',
  assistant: 'the assistant',
  revive: 'the automatic retry',
  picker: 'attaching it to a post',
  unknown: 'something',
};

/**
 * One line a person can read, for the register panel.
 *
 * Written here rather than in the component for the reason lib/health-plain.ts
 * gives: a second wording drifts from the first, and then two parts of the app
 * describe the same event differently.
 */
export function describeEntry(e: { event: string; actor?: string; detail?: Record<string, unknown> | null }): string {
  const who = ACTOR_WORDS[(e.actor as VideoActor) in ACTOR_WORDS ? (e.actor as VideoActor) : 'unknown'];
  const d = e.detail || {};
  const because = typeof d.error === 'string' && d.error ? ' — ' + d.error : '';

  switch (e.event) {
    case 'first_seen':
      return 'Added to the sheet, seen by ' + who + '.';
    case 'prepared':
      return 'Copy written by ' + who + '.';
    case 'failed':
      return 'Stopped' + (e.actor ? ' (' + who + ')' : '') + because;
    case 'copy_made':
      return 'A shareable copy was made, so this can carry its video.';
    case 'copy_failed':
      return 'No shareable copy could be made, so a post from this row would go out with no video' + because;
    case 'queued': {
      const nets = Array.isArray(d.networks) ? (d.networks as unknown[]).map(String) : [];
      return 'Sent to Metricool as a draft' + (nets.length ? ' for ' + nets.join(', ') : '') + ', awaiting approval.';
    }
    case 'retried':
      return 'Put back in the queue by ' + who + '.';
    case 'skipped':
      return 'Passed over by ' + who + (typeof d.reason === 'string' && d.reason ? ' — ' + d.reason : '') + '.';
    default:
      return String(e.event).replace(/_/g, ' ') + ' (' + who + ')';
  }
}

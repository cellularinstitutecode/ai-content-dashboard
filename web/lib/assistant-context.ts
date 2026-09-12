// web/lib/assistant-context.ts
// What the assistant knows about the video pipeline, and how it says it.
//
// The chat window has had real hands for a long time — it can generate, save,
// research and schedule — and no eyes at all. Its system prompt was entirely
// static, so it could act on the pipeline while being unable to say whether
// anything in it was broken. Asking it "what happened to that video?" got a
// confident guess.
//
// Everything here is pure: given a plain list of rows it produces the prompt
// block and the opening line. No Supabase, no fetch, no React — so the wording
// a person actually reads can be tested, which for a greeting that is the
// first thing they see every day is the whole point.
//
// Relative imports only; the test runner strips types and runs this directly.
import { failureKind, whyStopped } from './failure-kind.ts';
import { claimIsStale } from './video-row.ts';

export type Situation =
  /** Finished. Copy in the sheet, draft saved. */
  | 'done'
  /** A sweep is working on it right now. */
  | 'working'
  /** Queued, nothing wrong. */
  | 'waiting'
  /** Stopped, and only a person can move it on. */
  | 'needs_you'
  /** Stopped on something temporary; a retry is worth it. */
  | 'retryable'
  /** Stopped on something outside this row — a missing migration. */
  | 'blocked';

export type RunRow = {
  tab?: string | null;
  row_number?: number | null;
  video_title?: string | null;
  state?: string | null;
  attempts?: number | null;
  last_error?: string | null;
  last_error_code?: string | null;
  updated_at?: string | null;
  revivals?: number | null;
};

export type ProblemRow = {
  title: string;
  tab: string;
  row: number | null;
  situation: Situation;
  /** One sentence, no error codes, for a person to read. */
  plain: string;
};

export type HealthNote = {
  /** What has stopped working, in the words of the person reading it. */
  down: string;
  /** What carries on regardless. */
  stillWorks?: string;
  /**
   * Does this stop the VIDEO pipeline, or is it something else that happens to
   * be degraded?
   *
   * The distinction earns its place. The greeting reports a broken dependency
   * first and stops there — correct when the videos genuinely cannot run, and
   * badly wrong otherwise. The health probe spans three migration files, and
   * two of the tables it checks belong to the Autopilot templates queue. Left
   * undistinguished, a missing templates table opened the chat with a generic
   * database warning and never mentioned a single video: the exact silence the
   * situation block was built to end.
   */
  blocksVideos: boolean;
};

export type Snapshot = {
  counts: Record<Situation, number>;
  /** The problems worth naming out loud, already capped. */
  problems: ProblemRow[];
  /** What the overnight pass handed back to the queue, when it did anything. */
  recovery?: { revived: number; released: number } | null;
  /** Failing health checks, already in plain words. */
  health: HealthNote[];
  hasBrandProfile: boolean;
  /** True when nothing has ever been swept — a different message from "all clear". */
  everRun: boolean;
  /**
   * The pipeline list could not be READ this turn.
   *
   * Not the same as "there is nothing in it", and the difference is the whole
   * reason listRuns throws instead of returning []. The assistant used to
   * swallow that throw with .catch(() => []), so a database outage produced a
   * confident "everything is done or moving" — saying "nothing to report" is
   * exactly how a broken read looks like good news.
   */
  pipelineUnreadable?: boolean;
  /**
   * Rows that have permanently stopped and will never move without a person.
   *
   * Derived here rather than taken from the revive pass's own needsHuman count,
   * which is a per-run number that is persisted nowhere. This one is a property
   * of the rows themselves, so it is true whenever it is asked.
   */
  needsHuman?: number;
};

/** Named rows in the prompt. Beyond a handful this is a token bill, not context. */
const MAX_NAMED = 3;
/** A sheet title can be a paragraph. The model needs it recognisable, not complete. */
const MAX_TITLE = 60;

export function situationOf(row: RunRow, now: number): Situation {
  const state = String(row.state || '').trim();
  if (state === 'prepared' || state === 'skipped') return 'done';
  if (state === 'preparing') {
    // A claim nobody is holding is not work in progress — it is a run that
    // died, and calling it 'working' is how it stayed invisible.
    return claimIsStale(row.updated_at, now) ? 'retryable' : 'working';
  }
  if (state !== 'failed' && state !== 'needs_transcript') return 'waiting';

  const kind = failureKind(row.last_error_code ?? null);
  if (kind === 'blocked') return 'blocked';
  if (kind === 'terminal') return 'needs_you';
  return 'retryable';
}

function trimTitle(title: string | null | undefined, fallback: string): string {
  const t = String(title || '').trim() || fallback;
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t;
}

/**
 * Why this row is where it is, in words a person can act on.
 *
 * Prefers the failure's own sentence, because that was written for whoever
 * pressed the button and is more specific than any category. Falls back to the
 * category only when nothing was recorded.
 */
export function plainReason(row: RunRow, situation: Situation): string {
  const said = String(row.last_error || '').trim();
  if (situation === 'retryable' && String(row.state) === 'preparing') {
    return 'A run stopped part-way through this one. It is back in the queue.';
  }
  if (said) return said;
  const stopped = whyStopped(row.last_error_code ?? null, row.attempts ?? 0);
  if (stopped) return stopped;
  if (situation === 'needs_you') return 'This one needs you.';
  if (situation === 'blocked') return 'Waiting on a database update.';
  return 'Stopped without recording a reason.';
}

const EMPTY_COUNTS = (): Record<Situation, number> =>
  ({ done: 0, working: 0, waiting: 0, needs_you: 0, retryable: 0, blocked: 0 });

/**
 * Turn the rows into the few facts worth saying.
 *
 * Problems are ordered by who can act: the ones needing a person first, since
 * those are the only ones that will never resolve on their own.
 */
export function summarise(
  rows: RunRow[],
  now: number,
  extra: {
    recovery?: { revived: number; released: number } | null;
    health?: HealthNote[];
    hasBrandProfile?: boolean;
    pipelineUnreadable?: boolean;
  } = {},
): Snapshot {
  const counts = EMPTY_COUNTS();
  const problems: ProblemRow[] = [];

  for (const row of rows) {
    const situation = situationOf(row, now);
    counts[situation]++;
    if (situation === 'done' || situation === 'working' || situation === 'waiting') continue;
    problems.push({
      title: trimTitle(row.video_title, 'Untitled video'),
      tab: String(row.tab || '').trim(),
      row: typeof row.row_number === 'number' ? row.row_number : null,
      situation,
      plain: plainReason(row, situation),
    });
  }

  const rank: Record<string, number> = { blocked: 0, needs_you: 1, retryable: 2 };
  problems.sort((a, b) => (rank[a.situation] ?? 9) - (rank[b.situation] ?? 9));

  const recovery = extra.recovery && (extra.recovery.revived || extra.recovery.released) ? extra.recovery : null;
  return {
    counts,
    problems: problems.slice(0, MAX_NAMED),
    recovery,
    health: extra.health || [],
    hasBrandProfile: extra.hasBrandProfile !== false,
    everRun: rows.length > 0,
    pipelineUnreadable: extra.pipelineUnreadable === true,
    needsHuman: counts.needs_you + counts.blocked,
  };
}

function rowLabel(p: ProblemRow): string {
  const where = p.row ? 'row ' + p.row : p.tab;
  return where ? '"' + p.title + '" (' + where + ')' : '"' + p.title + '"';
}

/**
 * The block appended to the assistant's system prompt each turn.
 *
 * Written as facts rather than instructions, and capped by construction: three
 * named rows and a handful of counts, so a pipeline with two hundred rows
 * costs the same as one with five.
 */
export function renderSnapshot(s: Snapshot): string {
  const lines: string[] = [];
  lines.push('LIVE SITUATION (as of this message — do not repeat it verbatim, use it to answer):');

  if (s.pipelineUnreadable) {
    // Said FIRST and said plainly. An assistant that cannot read the pipeline
    // must not answer questions about it from the counts below, which in this
    // state are all zero for a reason that has nothing to do with the videos.
    lines.push(
      '- The video pipeline could not be READ this turn (a database error, not an empty queue). ' +
      'Do not say anything about how many videos are done, queued or stuck: you do not know. ' +
      'Say the list could not be read and offer to look again.',
    );
  } else if (!s.everRun) {
    lines.push('- No video has been through the pipeline yet on this account.');
  } else {
    const c = s.counts;
    lines.push(
      '- Videos: ' + c.done + ' done, ' + c.working + ' being worked on, ' + c.waiting + ' queued, ' +
      (c.needs_you + c.blocked) + ' waiting on a person, ' + c.retryable + ' worth retrying.',
    );
  }

  for (const p of s.problems) {
    lines.push('- ' + rowLabel(p) + ' — ' + p.plain + (p.situation === 'retryable' ? ' [retry_video can fix this]' : ''));
  }

  if (s.recovery) {
    const bits: string[] = [];
    if (s.recovery.revived) bits.push(s.recovery.revived + ' retried after a temporary failure');
    if (s.recovery.released) bits.push(s.recovery.released + ' put back after a run stopped part-way');
    lines.push('- Since the last pass: ' + bits.join(', ') + '.');
  }

  // Labelled distinctly, so the model does not tell somebody their videos are
  // broken when what is missing is a templates table for a different feature.
  for (const h of s.health) {
    const what = h.blocksVideos ? '- Stopping the video pipeline: ' : '- Degraded elsewhere (does NOT affect video): ';
    lines.push(what + h.down + (h.stillWorks ? ' ' + h.stillWorks : ''));
  }

  if (!s.hasBrandProfile) {
    lines.push('- No Brand Brain is saved, so copy is written in a default voice and Metricool hand-offs will be refused for missing an advertising notice.');
  }

  return lines.join('\n');
}

/**
 * The first thing said when the panel is opened.
 *
 * This used to be a fixed paragraph introducing the product to somebody who
 * has been using it daily for weeks. It is the single most-read message in the
 * app and it knew nothing — so it is now the status report, in priority order:
 * what is broken, then what needs them, then what can be fixed for them.
 */
export function greetingFor(s: Snapshot): { message: string; chips: string[] } {
  const chips: string[] = [];

  // Could not read the list at all. This has to come before the health notes
  // and before the counts: every branch below reads counts that are zero
  // because the query failed, and "everything is done or moving" is the single
  // most misleading sentence this function can produce.
  if (s.pipelineUnreadable) {
    return {
      message:
        'I could not read the video pipeline just now — that is a database error, not an empty queue, so I genuinely do not know what state the videos are in. ' +
        'Ask me again in a moment and I will look properly. Everything else I can help with meanwhile.',
      chips: ['Try again'],
    };
  }

  // Something the videos DEPEND ON is down. Say that before offering anything
  // that cannot work.
  //
  // Only that. This used to fire on any failing check at all, and the health
  // probe covers three migration files — so a missing Autopilot templates table
  // opened the chat with a database warning and never mentioned a video.
  const blocking = s.health.find((h) => h.blocksVideos);
  if (blocking) {
    return {
      message: blocking.down + (blocking.stillWorks ? ' ' + blocking.stillWorks : '') + ' Ask me anything meanwhile — I will tell you if what you want needs the part that is down.',
      chips: ['What still works?'],
    };
  }

  // Anything else degraded is real, but it is a footnote on the video report
  // rather than a replacement for it.
  const aside = s.health.length
    ? '\n\nSeparately: ' + s.health[0].down
    : '';

  const needsPerson = s.counts.needs_you + s.counts.blocked;
  const retryable = s.counts.retryable;

  if (!s.everRun) {
    return {
      message: 'Nothing has been through the video pipeline yet. Add a video link to the sheet and press Prepare, or ask me to write something.' + aside,
      chips: ['Write a post about NK cell therapy'],
    };
  }

  if (!needsPerson && !retryable) {
    const recovered = s.recovery
      ? ' Since the last pass I retried ' + (s.recovery.revived + s.recovery.released) + ' and they are moving again.'
      : '';
    return {
      message: 'Everything in the video pipeline is either done or moving.' + recovered + ' What would you like to work on?' + aside,
      chips: ['Show me the video pipeline', 'Write a post'],
    };
  }

  const parts: string[] = [];
  if (retryable) parts.push(retryable + (retryable === 1 ? ' video is' : ' videos are') + ' stuck on something temporary');
  if (needsPerson) parts.push(needsPerson + (needsPerson === 1 ? ' needs you' : ' need you'));

  const named = s.problems.slice(0, 2).map((p) => rowLabel(p) + ' — ' + p.plain);
  const message =
    parts.join(', and ') + '.' +
    (named.length ? '\n\n' + named.join('\n') : '') +
    (retryable ? '\n\nI can retry the temporary ones now — nothing goes to Metricool without you saying so.' : '') +
    aside;

  if (retryable === 1) chips.push('Retry that one');
  else if (retryable > 1) chips.push('Retry everything that is stuck');
  chips.push('Show me the video pipeline');

  return { message, chips };
}

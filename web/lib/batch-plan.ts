// Whether a batch may start, given what the plan call came back with.
//
// The plan call adds the sheet's KEYWORDS / REF / ESTADO IA columns before any row runs,
// because two rows appending them at the same time give the tab two sets and half the
// rows then write into the wrong one — damage a person unpicks by hand. The first version
// of the batch treated the call's result as advisory: it read the slots, never read
// columnErrors, and carried on through a 429 or a dropped connection.
//
// Pure and separate so the decision can be tested without a browser, and so the rule is
// stated once rather than tangled into a click handler.

/** A row, reduced to what the decision needs. */
export type PlanRow = {
  tab: string;
  /** Which AI columns that row's tab already has. */
  hasAiColumns: boolean;
};

export type PlanOutcome =
  | { ok: true }
  /** Nothing may start: a tab that needs the columns did not get them. */
  | { ok: false; reason: string };

/**
 * @param rows       the rows about to be prepared
 * @param failedTabs tabs the plan call could not add columns to (its `columnErrors`)
 * @param planError  a message when the call itself failed, so nothing is known
 */
export function mayStartBatch(
  rows: readonly PlanRow[],
  failedTabs: readonly string[],
  planError?: string | null,
): PlanOutcome {
  // Tabs that would need columns added. A tab that already has all three needs nothing
  // from the plan call and cannot be harmed by its failure — which is the common case,
  // and is what makes refusing affordable rather than obstructive.
  const needing = new Set(rows.filter((r) => !r.hasAiColumns).map((r) => r.tab));
  if (!needing.size) return { ok: true };

  if (planError) return { ok: false, reason: planError };

  const blocking = failedTabs.filter((t) => needing.has(t));
  if (blocking.length) {
    return {
      ok: false,
      reason: 'The KEYWORDS / REF / ESTADO IA columns could not be added to ' + blocking.join(' and ') +
        '. Running anyway would give that tab two sets of them, so nothing was started.',
    };
  }
  return { ok: true };
}

/** Where a batched row has got to. Mirrored in the component that renders it. */
export type BatchState = 'queued' | 'working' | 'done' | 'failed' | 'needs_transcript';

export type Tally = {
  total: number;
  done: number;
  failed: number;
  needsTranscript: number;
  /** Not yet finished — queued or in flight. */
  pending: number;
};

/**
 * How a run is going, countable at any moment.
 *
 * The end-of-run summary counts what the pool RETURNED, which is correct and exists only
 * once every row has finished. A batch takes minutes, and for all of them there was no
 * aggregate anywhere — only per-row cells scattered down a table below the fold, which is
 * how somebody ran one, saw nothing move, and concluded it had not started.
 */
export function tally(states: readonly BatchState[]): Tally | null {
  if (!states.length) return null;
  const n = (want: BatchState) => states.filter((s) => s === want).length;
  return {
    total: states.length,
    done: n('done'),
    failed: n('failed'),
    needsTranscript: n('needs_transcript'),
    pending: n('queued') + n('working'),
  };
}

/** Beyond a couple, the panel becomes a wall of text instead of an answer. */
const MAX_REASONS = 2;
/** A refusal can run to two sentences. Enough to recognise, not the whole paragraph. */
const MAX_REASON_CHARS = 150;

export type BatchReasons = {
  /** The distinct reasons, already trimmed and capped. */
  shown: string[];
  /** How many further DISTINCT reasons there were, beyond the ones shown. */
  more: number;
};

/**
 * Why the rows that did not finish did not finish.
 *
 * Every failed row already carries its reason — the batch stores the server's
 * own sentence as the row's note. But the panel people actually look at showed
 * only "✗ 2 not done" and then pointed at a table a thousand pixels further
 * down the page, past an embedded spreadsheet. The answer was on screen and
 * unreachable, which is a strange thing for a summary to do.
 *
 * Deduplicated, because that is the case that matters: when several videos stop
 * for one cause — and they usually do — it should read as one sentence, not the
 * same sentence repeated once per row.
 */
export function reasons(
  entries: readonly { state: BatchState; note?: string }[],
  max: number = MAX_REASONS,
): BatchReasons {
  const seen: string[] = [];
  for (const e of entries) {
    if (e.state !== 'failed' && e.state !== 'needs_transcript') continue;
    const note = String(e.note || '').replace(/\s+/g, ' ').trim();
    if (!note) continue;
    const text = note.length > MAX_REASON_CHARS ? note.slice(0, MAX_REASON_CHARS - 1) + '…' : note;
    if (!seen.includes(text)) seen.push(text);
  }
  return { shown: seen.slice(0, max), more: Math.max(0, seen.length - max) };
}

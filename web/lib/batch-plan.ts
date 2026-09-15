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

/** A row a summary line points at: the batch key (`tab:row`) and how to say it. */
export type RowRef = { key: string; label: string };

export type BatchReasons = {
  /** The distinct reasons, already trimmed and capped — each with the rows it applies to. */
  shown: { text: string; rows: RowRef[] }[];
  /** How many further DISTINCT reasons there were, beyond the ones shown. */
  more: number;
};

/** One batch entry as the summaries see it: the row key, its state, its note. */
export type BatchEntry = { key?: string; state: BatchState; note?: string };

/**
 * "row 183", or "Marzo · row 183" when the run spans more than one tab.
 *
 * The key is `tab:row` (the tab name may itself contain a colon, so the row
 * is the LAST segment). A key with no row reads as itself, never as blank.
 */
export function rowLabelFromKey(key: string | undefined, multiTab = false): string {
  const k = String(key || '').trim();
  if (!k) return '';
  const at = k.lastIndexOf(':');
  if (at < 0) return k;
  const row = k.slice(at + 1).trim();
  const tab = k.slice(0, at).trim();
  if (!/^\d+$/.test(row)) return k;
  return (multiTab && tab ? tab + ' \u00b7 ' : '') + 'row ' + row;
}

function tabOf(key: string | undefined): string {
  const k = String(key || '');
  const at = k.lastIndexOf(':');
  return at < 0 ? '' : k.slice(0, at);
}

function spansTabs(entries: readonly BatchEntry[]): boolean {
  return new Set(entries.map((e) => tabOf(e.key)).filter(Boolean)).size > 1;
}

function byRow(a: RowRef, b: RowRef): number {
  const ra = Number(a.key.slice(a.key.lastIndexOf(':') + 1));
  const rb = Number(b.key.slice(b.key.lastIndexOf(':') + 1));
  return (Number.isFinite(ra) ? ra : 0) - (Number.isFinite(rb) ? rb : 0);
}

/**
 * Why the rows that did not finish did not finish — WITH the rows.
 *
 * Every failed row already carries its reason — the batch stores the server's
 * own sentence as the row's note. But the panel people actually look at showed
 * only "✗ 2 not done" and then pointed at a table a thousand pixels further
 * down the page, past an embedded spreadsheet. The answer was on screen and
 * unreachable, which is a strange thing for a summary to do. And when it did
 * say the reason, it did not say WHICH row — "Interrupted — press Prepare
 * again to finish this one" with no way to know which one.
 *
 * Deduplicated, because that is the case that matters: when several videos stop
 * for one cause — and they usually do — it should read as one sentence with the
 * rows listed, not the same sentence repeated once per row.
 */
export function reasons(
  entries: readonly BatchEntry[],
  max: number = MAX_REASONS,
): BatchReasons {
  const multi = spansTabs(entries);
  const seen: { text: string; rows: RowRef[] }[] = [];
  for (const e of entries) {
    if (e.state !== 'failed' && e.state !== 'needs_transcript') continue;
    const note = String(e.note || '').replace(/\s+/g, ' ').trim();
    if (!note) continue;
    const text = note.length > MAX_REASON_CHARS ? note.slice(0, MAX_REASON_CHARS - 1) + '\u2026' : note;
    let hit = seen.find((r) => r.text === text);
    if (!hit) { hit = { text, rows: [] }; seen.push(hit); }
    if (e.key && !hit.rows.some((r) => r.key === e.key)) hit.rows.push({ key: e.key, label: rowLabelFromKey(e.key, multi) });
  }
  for (const r of seen) r.rows.sort(byRow);
  return { shown: seen.slice(0, max), more: Math.max(0, seen.length - max) };
}

/** Which rows are behind each count, so a chip can say "✗ 1 not done · row 183". */
export function tallyRows(entries: readonly BatchEntry[]): { failed: RowRef[]; needsTranscript: RowRef[]; pending: RowRef[] } {
  const multi = spansTabs(entries);
  const pick = (want: (s: BatchState) => boolean) => entries
    .filter((e) => e.key && want(e.state))
    .map((e) => ({ key: String(e.key), label: rowLabelFromKey(e.key, multi) }))
    .sort(byRow);
  return {
    failed: pick((s) => s === 'failed'),
    needsTranscript: pick((s) => s === 'needs_transcript'),
    pending: pick((s) => s === 'queued' || s === 'working'),
  };
}

/** "row 183, row 190" — up to `max` inline, then "+N". */
export function rowList(rows: readonly RowRef[], max = 3): string {
  if (!rows.length) return '';
  const head = rows.slice(0, max).map((r) => r.label).join(', ');
  return rows.length > max ? head + ' +' + (rows.length - max) : head;
}

/**
 * What a finished run added up to, with the rows behind every miss:
 * "2 written into the sheet · 1 need a transcript (row 190) · 1 not done
 * (row 183: Interrupted — press Prepare again)".
 */
export function runSummary(entries: readonly BatchEntry[]): string {
  const multi = spansTabs(entries);
  const n = (want: BatchState) => entries.filter((e) => e.state === want).length;
  const named = (want: BatchState, withNote: boolean) => entries
    .filter((e) => e.state === want)
    .map((e) => {
      const label = rowLabelFromKey(e.key, multi) || 'a row';
      const note = withNote ? String(e.note || '').replace(/\s+/g, ' ').trim() : '';
      const short = note.length > 80 ? note.slice(0, 79) + '\u2026' : note;
      return short ? label + ': ' + short : label;
    })
    .join('; ');
  const parts: string[] = [];
  if (n('done')) parts.push(n('done') + ' written into the sheet');
  if (n('needs_transcript')) parts.push(n('needs_transcript') + ' need a transcript (' + named('needs_transcript', false) + ')');
  if (n('failed')) parts.push(n('failed') + ' not done (' + named('failed', true) + ')');
  return parts.join(' \u00b7 ') || 'Nothing to report.';
}

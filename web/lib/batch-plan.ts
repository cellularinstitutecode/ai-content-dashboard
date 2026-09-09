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

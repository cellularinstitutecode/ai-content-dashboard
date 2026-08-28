// The spend decision for Semrush's paid unit pot, as a pure function.
//
// This lived inline in lib/semrush.ts as:
//
//   if (bal == null) return true;   // can't read balance → let the API decide
//
// which is a guard that opens itself the moment it loses sight of the thing it
// is guarding. And the API's "decision" is to spend the units. Combined with a
// balance cache that stored an unreadable reading for the full ten-minute TTL,
// one HTML error page from the balance endpoint switched the protection off for
// ten minutes while paid calls kept succeeding — silently, which is the part
// that matters, because the symptom only shows up on an invoice.
//
// Extracted here with no imports so the rule can be tested directly, the same
// way lib/machine-auth.ts and lib/tool-transcript.ts were. The caching and the
// HTTP live in lib/semrush.ts; only the judgement lives here.

export type SpendDecision = {
  allow: boolean;
  /** Why, for logging and for the tests to assert against. */
  reason: 'no-key' | 'balance-unknown' | 'below-floor' | 'ok';
};

/**
 * May we spend `estUnits` right now?
 *
 * Fails CLOSED on an unknown balance, matching every other guard in this
 * codebase (the rate limiter especially). The cost of being wrong in the closed
 * direction is that keyword data degrades to cache-or-link-out for a few
 * seconds — a path the app already handles everywhere. The cost of being wrong
 * in the open direction is the clinic's unit pot.
 */
export function decideSpend(
  balance: number | null,
  estUnits: number,
  floor: number,
  hasKey: boolean,
): SpendDecision {
  if (!hasKey) return { allow: false, reason: 'no-key' };
  if (balance == null || !Number.isFinite(balance)) {
    return { allow: false, reason: 'balance-unknown' };
  }
  if (balance - estUnits < floor) return { allow: false, reason: 'below-floor' };
  return { allow: true, reason: 'ok' };
}

/**
 * Apply a spend to a cached balance.
 *
 * The cache was never decremented, so every caller inside one TTL measured the
 * same pre-spend headroom — `domainBundle` fires four reports in a Promise.all
 * and all four saw the balance as it was before any of them ran, letting a
 * burst overshoot the floor by its own size. This keeps the number moving in
 * the right direction between live reads. It is an estimate, not a source of
 * truth; the next real read replaces it.
 */
export function applyCharge(balance: number | null, units: number): number | null {
  if (balance == null || !Number.isFinite(balance)) return balance;
  if (!Number.isFinite(units) || units <= 0) return balance;
  return Math.max(0, balance - units);
}

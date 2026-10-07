// web/lib/semrush-policy.ts
// WHO may spend Semrush units: the policy gate in front of the budget guard.
//
// The budget guard (lib/semrush-budget.ts) answers "is there enough left?".
// This answers the question that comes before it: "should this request be
// spending at all?" — because most of the clinic's units were going to jobs
// nobody asked for. The hourly Autopilot, the 15-minute video watcher, a
// strategy drop, the voice session's warm-up and the SEO panel opening on
// page load each ran live keyword lookups on their own schedule, and a month
// of that is tens of thousands of units for data that a cached entry, or the
// model's own keyword sense, would have covered.
//
// Three modes, set with SEMRUSH_MODE:
//
//   manual  (default) Only a request a person started on purpose — the SEO
//           panel's Analyze / Inspect / Advisor / Rankings buttons, the
//           Keyword Intelligence hub — may make a live call. Every automatic
//           path reads the cache (fresh or stale) and otherwise falls back to
//           the model's own keywords, exactly as it already does when the
//           unit floor is reached.
//   off     No live calls from anywhere. Cache-only.
//   auto    The old behaviour: anything inside the budget may spend.
//
// A request is "started on purpose" when its route handler wrapped the work in
// `withUserSemrush()`. Nothing else has to be threaded through the call tree:
// the origin rides on AsyncLocalStorage, and the default — no wrapper — is the
// safe answer, so a new caller cannot spend by forgetting to opt out.
//
// The pure decision is kept apart from the storage so it can be unit-tested
// without a server.

import { AsyncLocalStorage } from 'node:async_hooks';

export type SemrushMode = 'auto' | 'manual' | 'off';
export type SemrushOrigin = 'user' | 'auto';

export const DEFAULT_SEMRUSH_MODE: SemrushMode = 'manual';

/** Parse SEMRUSH_MODE. Anything unrecognised is the safe default, manual. */
export function parseSemrushMode(raw: string | undefined | null): SemrushMode {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'auto' || v === 'manual' || v === 'off') return v;
  return DEFAULT_SEMRUSH_MODE;
}

export function semrushMode(): SemrushMode {
  return parseSemrushMode(process.env.SEMRUSH_MODE);
}

/** May a request of this origin make a live Semrush call under this mode? */
export function liveAllowedByPolicy(mode: SemrushMode, origin: SemrushOrigin): boolean {
  if (mode === 'off') return false;
  if (mode === 'auto') return true;
  return origin === 'user';
}

const originStore = new AsyncLocalStorage<{ origin: SemrushOrigin }>();

/** The origin of the request currently running. Unmarked work is automatic. */
export function currentSemrushOrigin(): SemrushOrigin {
  return originStore.getStore()?.origin ?? 'auto';
}

/**
 * Run `fn` as work a person asked for. Route handlers call this around the
 * actions behind an explicit button; everything inside — however deep the
 * call tree — may then spend units in manual mode.
 */
export function withUserSemrush<T>(fn: () => Promise<T>): Promise<T> {
  return originStore.run({ origin: 'user' }, fn);
}

/** The live decision for the code that is running right now. */
export function liveSemrushAllowed(): boolean {
  return liveAllowedByPolicy(semrushMode(), currentSemrushOrigin());
}

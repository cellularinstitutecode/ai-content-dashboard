// web/lib/batch-item.ts
// Is this batch item worth spending anything on?
//
// Pulled out of lib/batch-draft.ts so it can run BEFORE the rate limiter.
// checkRateLimit inserts a usage_event on success — it spends a token, it does
// not peek — so validating inside draftAndQueue meant ten items with a
// mis-computed date burned ten 'generate' tokens, a third of the hourly
// allowance shared with the dashboard's own Generate button, for zero AI calls.
//
// No imports: the test runner strips types and runs this file directly.

/** The networks Metricool can be handed a post for. Mirrors NETWORK_MAP in lib/batch-draft.ts. */
export const BATCH_NETWORKS = [
  'facebook', 'instagram', 'twitter', 'x', 'linkedin', 'tiktok', 'youtube', 'threads',
] as const;

/**
 * Why this item cannot be attempted, or null if it can.
 *
 * Only checks that cost nothing. Anything needing the database, the clock budget
 * or a network call stays in draftAndQueue.
 */
export function batchItemProblem(item: {
  topic?: unknown;
  network?: unknown;
  publishAt?: unknown;
}, now: number = Date.now()): string | null {
  const topic = String(item?.topic ?? '').trim();
  if (!topic) return 'No topic was given for this item.';

  const network = String(item?.network ?? '').trim().toLowerCase();
  if (!network) return 'No network was given for this item.';
  if (!(BATCH_NETWORKS as readonly string[]).includes(network)) {
    return 'There is no network called "' + network + '".';
  }

  const raw = String(item?.publishAt ?? '').trim();
  if (!raw) return 'No date and time was given for this item.';
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return 'That is not a usable date and time.';
  // Metricool accepts a past date and then refuses it when somebody opens the
  // draft to approve it — by which point it has been sitting in the queue
  // looking finished. Caught here, where the answer is still useful and before
  // anything has been spent.
  if (at <= now) return 'That time has already passed, so Metricool would refuse the draft when you opened it.';

  return null;
}

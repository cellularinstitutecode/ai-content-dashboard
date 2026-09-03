// Why an image generation failed, in terms a health check and a banner can act
// on. Split out of lib/provider-status.ts — which is `server-only` and talks to
// Supabase — because this part is pure string reading and worth testing on its
// own, the same split lib/image-verdict.ts already has from lib/images.ts.

/** Why the last attempt failed, in terms that decide who needs to do what. */
export type ImageFailureReason = 'no_credit' | 'rate_limited' | 'bad_key' | 'other';

/** How long a failure still says something about right now. */
export const OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Read a provider's own words for the failure and name the cause.
 *
 * lib/images.ts throws `openai images <status>: <body>`, so the status line and
 * the provider's error code are both in the string.
 */
export function classifyImageFailure(message: string): ImageFailureReason {
  const m = String(message || '');
  if (/credit_balance_exhausted|insufficient_quota|billing_hard_limit|billing/i.test(m)) return 'no_credit';
  if (/invalid_api_key|\b401\b|\b403\b|unauthorized/i.test(m)) return 'bad_key';
  // Order matters: OpenAI returns 429 for BOTH "too fast" and "out of credit",
  // so the credit codes above have to be tested first or an empty wallet reads
  // as a busy minute and nobody goes and tops it up.
  if (/\b429\b|rate.?limit/i.test(m)) return 'rate_limited';
  return 'other';
}

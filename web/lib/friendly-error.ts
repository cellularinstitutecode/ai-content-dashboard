// One place that turns a failed request into a sentence a person can act on.
//
// Every panel used to translate errors for itself, or not at all, so the same
// failure read differently depending on where you were standing. The worst case
// was an expired session: middleware answers {"error":"unauthenticated"}, which
// matched no rule in the generator's own mapping, so a coordinator whose login
// had lapsed was told "The AI provider rejected the API key" and went looking
// for a billing problem that did not exist.
//
// Rules of the house:
//   * a `message` written by our own API always wins - it was written for this
//     exact situation and knows things this function cannot;
//   * a machine code is never shown to a person;
//   * an upstream provider's raw error body is never shown to a person either.

/** Sentences for the error codes our own routes return. */
const BY_CODE: Record<string, string> = {
  unauthenticated: 'Your session has expired. Sign in again to continue.',
  unauthorized: 'Your session has expired. Sign in again to continue.',
  forbidden: 'This account is not authorized for this workspace.',
  not_allowed: 'This account is not authorized for this workspace.',
  rate_limited: 'That is a lot of requests in one hour. Give it a few minutes and try again.',
  not_found: 'We could not find that any more — it may have been deleted.',
  invalid_request: 'Something about that request was not right. Check the fields and try again.',
};

export const GENERIC_FAILURE = 'Something went wrong on our side. Try again in a moment.';

function fromMessage(message: string): string | null {
  const m = message.trim();
  if (!m) return null;
  if (/credit_balance_exhausted|insufficient_quota|billing/i.test(m)) {
    return 'The AI account is out of credit. Add credits, or switch the model to Claude (Anthropic) to keep going.';
  }
  if (/\b429\b|rate.?limit/i.test(m)) {
    return 'The AI provider is busy right now. Wait a moment and try again, or switch models.';
  }
  if (/\b401\b|invalid.?api.?key/i.test(m)) {
    return 'The AI provider rejected its API key. Ask whoever set this up to check the key.';
  }
  if (/timed out|timeout|abort/i.test(m)) {
    return 'That took too long and was stopped. Try again — if it keeps happening, try a shorter piece.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return 'We could not reach the server. Check your connection and try again.';
  }
  return null;
}

/**
 * Turn anything a failed request produced into one plain sentence.
 *
 * @param input   a parsed JSON body ({ error, message }), an Error, or a string
 * @param fallback what to say when nothing else fits
 */
export function friendlyError(input: unknown, fallback: string = GENERIC_FAILURE): string {
  if (input == null) return fallback;

  if (typeof input === 'object' && !(input instanceof Error)) {
    const body = input as Record<string, unknown>;
    // Our own routes write a `message` for the human and an `error` for the
    // machine. Prefer the human one, always.
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message) return message;
    const code = typeof body.error === 'string' ? body.error.trim() : '';
    if (code) {
      if (BY_CODE[code]) return BY_CODE[code];
      const guessed = fromMessage(code);
      if (guessed) return guessed;
      // A bare snake_case code is a machine token, not a sentence - never show
      // it. Anything longer was already prose.
      if (/^[a-z0-9_.:-]+$/.test(code)) return fallback;
      return code.length > 200 ? code.slice(0, 200) + '…' : code;
    }
    return fallback;
  }

  const raw = input instanceof Error ? input.message : String(input);
  if (BY_CODE[raw.trim()]) return BY_CODE[raw.trim()];
  const guessed = fromMessage(raw);
  if (guessed) return guessed;
  if (!raw.trim()) return fallback;
  if (/^[a-z0-9_.:-]+$/.test(raw.trim())) return fallback;
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

/**
 * Read a fetch Response that is not ok and say what went wrong.
 * Handles the case where the body is not JSON at all (a proxy error page, a
 * platform timeout with no body) instead of throwing a second error.
 */
export async function friendlyErrorFromResponse(
  res: Response,
  fallback: string = GENERIC_FAILURE,
): Promise<string> {
  if (res.status === 504 || res.status === 408) {
    return 'That took too long and the server stopped it. Try again — if it keeps happening, try a shorter piece.';
  }
  let body: unknown = null;
  try {
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    }
  } catch { /* body already consumed or unreadable */ }
  if (body == null) {
    if (res.status === 401) return BY_CODE.unauthenticated;
    if (res.status === 403) return BY_CODE.forbidden;
    if (res.status === 429) return BY_CODE.rate_limited;
    if (res.status === 404) return BY_CODE.not_found;
    return fallback;
  }
  return friendlyError(body, fallback);
}

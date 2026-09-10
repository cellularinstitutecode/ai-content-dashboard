// web/lib/writer-failure.ts
// Why the writer did not answer, in words the person reading it can act on.
//
// lib/video-prepare.ts caught every failure from generateContentPack and
// returned one sentence: "The writer did not answer just now. Try again in a
// moment." That sentence fits a rate limit, an empty account, a revoked key, a
// prompt over the context limit and a request that ran out of clock equally
// well — which is to say it fits none of them, and only one of the five is
// actually worth trying again in a moment.
//
// The information was there the whole time. callAnthropic throws
// `anthropic 429: {"type":"error",...}` and callOpenAI the same shape; the
// catch discarded it. This turns those into a clause, and — the part that
// matters more — says whether the person should press the button again or
// fetch somebody who can change a setting.
//
// No imports: the test runner strips types and runs this file directly, and
// redaction is applied by the caller, which owns lib/report.ts.

export type WriterFailure = {
  /** One clause, lower case, to follow "The writer did not answer just now: ". */
  said: string;
  /** Is pressing Prepare again worth anything? */
  retryable: boolean;
};

/** The provider and HTTP status, when the message carries them. */
function statusOf(message: string): { provider: string; status: number } | null {
  const m = /^(anthropic|openai)\s+(\d{3})\b/i.exec(message.trim());
  return m ? { provider: m[1].toLowerCase(), status: Number(m[2]) } : null;
}

/**
 * What happened, and whether to try again.
 *
 * Ordered by what a person would do about it. A 401 and a 429 are both "the
 * writer refused", and confusing them wastes an afternoon: one needs a key
 * changed by whoever set this up, the other needs sixty seconds of patience.
 */
export function describeWriterFailure(err: unknown): WriterFailure {
  const message = err instanceof Error ? String(err.message || '') : String(err || '');

  if (/ANTHROPIC_API_KEY missing|OPENAI_API_KEY missing/i.test(message)) {
    return { said: 'no AI is connected to this deployment', retryable: false };
  }

  const s = statusOf(message);
  if (s) {
    if (s.status === 401 || s.status === 403) {
      return { said: 'the AI provider rejected the key on this deployment', retryable: false };
    }
    if (s.status === 429) {
      // Both a rate limit and an exhausted balance arrive as 429, and they are
      // not the same problem: one clears by itself.
      return /credit|billing|quota|insufficient/i.test(message)
        ? { said: 'the AI account is out of credit', retryable: false }
        : { said: 'the AI provider is rate-limiting this account', retryable: true };
    }
    if (s.status === 400 && /context|too long|max_tokens|token/i.test(message)) {
      return { said: 'the request was too long for the model', retryable: false };
    }
    if (s.status >= 500) {
      return { said: 'the AI provider had an error at its end', retryable: true };
    }
    return { said: 'the AI provider refused the request (HTTP ' + s.status + ')', retryable: s.status !== 400 };
  }

  // fetchWithRetry's own wording when every attempt aborted or the socket died.
  if (/failed after \d+ attempts/i.test(message) || /abort/i.test(message)) {
    return { said: 'it ran out of time before the model replied', retryable: true };
  }
  if (/malformed JSON|returned no /i.test(message)) {
    return { said: 'the model returned something unusable twice running', retryable: true };
  }
  return { said: 'the reason was not recorded', retryable: true };
}

/** Just the clause, for callers that only want to finish a sentence. */
export function writerFailure(err: unknown): string {
  return describeWriterFailure(err).said;
}

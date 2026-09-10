// web/lib/sse-stream.ts
// Reading a server-sent-event stream down to the text it carries.
//
// The writer streams now. A non-streaming request holds the socket open and
// silent until the whole answer is composed, which for two 800-1100 character
// posts is exactly the shape that trips a request timeout — and a timeout in
// the writer is the failure that ends a run with the transcript already paid
// for. Streaming keeps the connection producing, so the only thing that can end
// it is the deadline the caller actually set.
//
// Hand-rolled rather than reached for through @anthropic-ai/sdk: every call in
// lib/ai.ts is a plain fetch through one retry loop that owns the attempt plan
// and the abort deadline, and threading a single call through a second HTTP
// stack would put two different timeout semantics in the same function.
//
// Its own file, with no imports, because lib/ai.ts pulls in `server-only` and
// therefore cannot be loaded by `node --experimental-strip-types --test` — and
// framing code that has never been run against a split chunk is framing code
// that has never been tested.

/**
 * Accumulate the text deltas of an Anthropic message stream.
 *
 * Three things this must get right, and all of them are invisible with tidy
 * input:
 *
 *  - TCP does not respect SSE framing. A frame can arrive in three reads with
 *    its blank-line terminator in the last of them, so only WHOLE frames are
 *    consumed and the remainder is carried forward.
 *  - An error can arrive after a 200. Returning what came before it hands the
 *    caller half a JSON object, which reads as malformed — and lib/ai.ts
 *    re-rolls malformed JSON at full price, so a rate limit would show up as a
 *    bill rather than as a rate limit.
 *  - `stop_reason` arrives on `message_delta`, and `max_tokens` means the answer
 *    was CUT OFF. The first version of this file ignored that event, so a
 *    truncated body went to parseJsonStrict, came back as "malformed JSON", and
 *    was re-rolled — spending a second call to reproduce a certainty, then
 *    reporting "the model returned something unusable twice running" about a
 *    model that had told us exactly what happened. Reading it is the difference
 *    between a wrong ceiling somebody can raise and a mystery.
 */
export async function readAnthropicStream(res: Response): Promise<string> {
  const body = res.body;
  if (!body) throw new Error('anthropic: the response carried no stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  let stopReason = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    const frames = buffered.split('\n\n');
    // The tail is whatever follows the last complete frame — usually '', and
    // sometimes half an event that the next read finishes.
    buffered = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        // ':' opens a comment (keep-alives use it); 'event:' names the type,
        // which is already in the payload. Only 'data:' carries anything.
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event: { type?: string; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { message?: string } };
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.type === 'error') {
          throw new Error('anthropic stream error: ' + (event.error?.message || 'unknown'));
        }
        if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = String(event.delta.stop_reason);
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text ?? '';
        }
      }
    }
  }

  // Cut off, not garbled. Said here rather than left for parseJsonStrict,
  // which can only report the symptom — and whose caller answers a malformed
  // body by asking again, at full price, for the same truncation.
  if (stopReason === 'max_tokens') {
    throw new Error('anthropic: the answer was cut off at max_tokens after ' + text.length + ' characters');
  }
  return text;
}

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
  // message_stop is the stream's own "that was all". Without it, and without
  // a stop reason, the socket closed on us — the answer is whatever got
  // through, which is not an answer.
  let sawStop = false;

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
        if (event.type === 'message_stop') sawStop = true;
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
  // Declined, not garbled. The classifier can stop a medical text with an
  // empty or partial body; parsing that reads as "malformed" and is re-rolled
  // to reach the same decision. lib/ai.ts turns this into a hard failure.
  if (stopReason === 'refusal') {
    throw new Error('anthropic: the model declined this request (refusal)');
  }
  // Dropped, not garbled. A connection the platform or a proxy closed
  // mid-answer ends the reader cleanly, with no error event and no stop —
  // and the half object it leaves used to be reported as the model's fault.
  if (!stopReason && !sawStop) {
    throw new Error('anthropic: the stream ended early after ' + text.length + ' characters');
  }
  return text;
}

/** What a streamed tool turn resolves to: the text, and the one tool call the model made, if any. */
export type StreamedToolTurn = {
  text: string;
  toolCall: { id: string; name: string; input: Record<string, unknown> } | null;
  stopReason: string;
};

/**
 * A Messages stream that may carry a tool call, read as it arrives.
 *
 * The assistant's answer used to reach the panel whole, after the model had
 * finished — up to twenty seconds of "Working…" for a paragraph that was
 * being written the entire time. This hands every text delta to `onText` as
 * it lands, and assembles a tool_use block from its input_json_delta frames
 * so the caller sees exactly what the non-streaming call would have returned.
 */
export async function readAnthropicToolStream(res: Response, onText: (delta: string) => void): Promise<StreamedToolTurn> {
  const body = res.body;
  if (!body) throw new Error('anthropic: the response carried no stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';
  let stopReason = '';
  let sawStop = false;
  // The block being built, by index: text, or a tool_use with its JSON in pieces.
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split('\n\n');
    buffered = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event: {
          type?: string; index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          error?: { message?: string };
        };
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.type === 'error') throw new Error('anthropic stream error: ' + (event.error?.message || 'unknown'));
        if (event.type === 'content_block_start' && event.content_block) {
          blocks.set(event.index ?? 0, { type: String(event.content_block.type || ''), id: event.content_block.id, name: event.content_block.name, json: '' });
        } else if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta') {
            const piece = event.delta.text ?? '';
            if (piece) { text += piece; onText(piece); }
          } else if (event.delta.type === 'input_json_delta') {
            const b = blocks.get(event.index ?? 0);
            if (b) b.json += event.delta.partial_json ?? '';
          }
        } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = String(event.delta.stop_reason);
        } else if (event.type === 'message_stop') {
          sawStop = true;
        }
      }
    }
  }
  if (!sawStop && !stopReason) throw new Error('anthropic: the stream ended before the answer did');

  let toolCall: StreamedToolTurn['toolCall'] = null;
  for (const b of blocks.values()) {
    if (b.type !== 'tool_use' || toolCall) continue;
    let input: Record<string, unknown> = {};
    if (b.json.trim()) {
      try { input = JSON.parse(b.json) as Record<string, unknown>; } catch { throw new Error('anthropic: the tool call arrived malformed'); }
    }
    toolCall = { id: String(b.id || ''), name: String(b.name || ''), input };
  }
  return { text, toolCall, stopReason };
}

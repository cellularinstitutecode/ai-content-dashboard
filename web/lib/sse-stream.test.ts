// The SSE reader, against the wire format it will actually meet.
//
// New parsing code on the path that writes every caption. The failure modes are
// all about framing — a chunk boundary landing mid-frame, an error arriving
// after a 200 — and none of them show up if the test feeds it whole, tidy
// events.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readAnthropicStream } from './sse-stream.ts';

/** A Response whose body yields exactly these byte chunks, in order. */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  }));
}

const delta = (text: string) =>
  'event: content_block_delta\ndata: ' +
  JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } }) +
  '\n\n';

test('the text of a well-formed stream is reassembled in order', async () => {
  const got = await readAnthropicStream(streamOf([
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    delta('{"instagram":'),
    delta('"hello"}'),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]));
  assert.equal(got, '{"instagram":"hello"}');
});

test('a frame split across chunk boundaries is not lost', async () => {
  // The failure this reader is most likely to have: TCP does not respect SSE
  // framing, so a delta can arrive in three pieces with the blank-line
  // terminator in a later read.
  const whole = delta('one') + delta('two');
  const cut = [whole.slice(0, 12), whole.slice(12, 40), whole.slice(40)];
  assert.equal(await readAnthropicStream(streamOf(cut)), 'onetwo');
});

test('an error after a 200 throws instead of returning a truncated body', async () => {
  // Anthropic can send an error mid-stream. Returning what arrived before it
  // would hand the caller half a JSON object, which parseJsonStrict reports as
  // malformed — and generateContentPack re-rolls malformed JSON at full price,
  // hiding a rate limit behind a bill.
  await assert.rejects(
    () => readAnthropicStream(streamOf([
      delta('{"instagram":"partial'),
      'event: error\ndata: {"type":"error","error":{"message":"overloaded_error"}}\n\n',
    ])),
    /overloaded_error/,
  );
});

test('keep-alives, comments and unparseable frames are skipped, not fatal', async () => {
  const got = await readAnthropicStream(streamOf([
    ': keep-alive\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'data: not json at all\n\n',
    delta('ok'),
  ]));
  assert.equal(got, 'ok');
});

test('a response with no body at all is reported rather than read as empty', async () => {
  // An empty string would be parsed as malformed JSON and re-rolled; saying so
  // costs one clear error instead of a second paid attempt.
  await assert.rejects(() => readAnthropicStream(new Response(null, { status: 200 })), /no stream/);
});

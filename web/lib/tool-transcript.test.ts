// The invariant that makes trimming safe. Run with: npm test
//
// The assistant's tool transcript round-trips through the browser, so it has to
// be bounded. But it is not a flat list: it alternates
//   user(text) -> [assistant(tool_use) -> user(tool_result)] x k -> assistant(text)
// and Anthropic rejects any request where a tool_result has no matching
// tool_use in the message before it. A naive `slice(-n)` lands on an arbitrary
// index, and after a handful of ordinary turns it starts cutting pairs in half.
//
// That failure does not self-heal: the 400 throws before the trimmed list is
// stored, so the same window is re-sent next turn and the assistant silently
// degrades to a plain chatbot until the page is reloaded. Hence this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundToolMessages, type ToolMessage } from './tool-transcript.ts';

let seq = 0;
function turn(toolCalls: number): ToolMessage[] {
  const out: ToolMessage[] = [{ role: 'user', content: 'user says something ' + seq++ }];
  for (let i = 0; i < toolCalls; i++) {
    const id = 'tu_' + seq++;
    out.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'generate_content', input: {} }] });
    out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'result' }] });
  }
  out.push({ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] });
  return out;
}

/** Every tool_result must be preceded by an assistant message carrying its tool_use. */
function assertWellFormed(messages: ToolMessage[]) {
  const seen = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (m.role === 'assistant' && b?.type === 'tool_use') seen.add(b.id);
      if (m.role === 'user' && b?.type === 'tool_result') {
        assert.ok(
          seen.has(b.tool_use_id),
          'orphan tool_result ' + b.tool_use_id + ' - Anthropic answers this with a 400',
        );
      }
    }
  }
}

test('a long conversation never produces an orphan tool_result', () => {
  // The exact shape that broke the naive slice: mixed 1- and 2-tool turns, well
  // past the message cap.
  let transcript: ToolMessage[] = [];
  for (let t = 0; t < 20; t++) {
    transcript = [...transcript, ...turn(t % 3 === 0 ? 2 : 1)];
    const bounded = boundToolMessages(transcript);
    assertWellFormed(bounded);
    // Feeding the bounded list back in (what actually happens turn to turn)
    // must also stay well-formed.
    assertWellFormed(boundToolMessages(bounded));
    transcript = bounded;
  }
});

test('trimming keeps whole turns, and starts at a plain-text user message', () => {
  let transcript: ToolMessage[] = [];
  for (let t = 0; t < 12; t++) transcript = [...transcript, ...turn(2)];
  const bounded = boundToolMessages(transcript);
  assert.ok(bounded.length > 0, 'should retain recent context');
  assert.equal(bounded[0].role, 'user');
  assert.equal(typeof bounded[0].content, 'string', 'must begin at a turn boundary');
});

test('short transcripts pass through untouched', () => {
  const t = turn(1);
  assert.equal(boundToolMessages(t).length, t.length);
});

test('oversized content is truncated, never dropped', () => {
  const id = 'tu_big';
  const transcript: ToolMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'generate_content', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(200000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(200000) }] },
  ];
  const bounded = boundToolMessages(transcript);
  // Dropping the oversized tool_result would orphan the tool_use before it.
  assert.equal(bounded.length, 4);
  assertWellFormed(bounded);
  assert.ok((bounded[2].content as any[])[0].content.length < 9000, 'tool_result text truncated');
  assert.ok((bounded[3].content as any[])[0].text.length < 9000, 'assistant text truncated');
  assert.equal((bounded[2].content as any[])[0].tool_use_id, id, 'tool_use_id preserved');
});

test('a giant single turn restarts the transcript rather than sending a broken one', () => {
  // 60 tool calls in one turn: no boundary fits the cap, so the safe answer is
  // an empty transcript, which is always valid.
  const bounded = boundToolMessages(turn(60));
  assert.deepEqual(bounded, []);
});

test('junk entries are discarded without breaking the pairing', () => {
  const id = 'tu_1';
  const transcript = [
    null,
    'not a message',
    { role: 'system', content: 'nope' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  ] as unknown;
  const bounded = boundToolMessages(transcript);
  assert.equal(bounded.length, 3);
  assertWellFormed(bounded);
});

test('non-array input is an empty transcript, not a crash', () => {
  assert.deepEqual(boundToolMessages(undefined), []);
  assert.deepEqual(boundToolMessages(null), []);
  assert.deepEqual(boundToolMessages('nope'), []);
  assert.deepEqual(boundToolMessages({ role: 'user' }), []);
});

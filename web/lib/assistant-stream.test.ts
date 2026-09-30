// web/lib/assistant-stream.test.ts
// The answer as it is written, not after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the model call streams when the panel is listening, and the live block is cached within a turn', () => {
  const ai = src('lib/ai.ts');
  const call = ai.slice(ai.indexOf('export async function chatWithTools'), ai.indexOf('// AI Research & Draft Copilot'));
  assert.match(call, /const streaming = typeof opts\.onText === "function";/);
  assert.match(call, /\.\.\.\(streaming \? \{ stream: true \} : \{\}\)/);
  assert.match(call, /readAnthropicToolStream\(res, opts\.onText!\)/);
  assert.match(call, /text: systemExtra, cache_control: \{ type: 'ephemeral' \}/, 'the live block is re-read up to four times per message otherwise');
  // The reader assembles a tool call from its pieces, and refuses a stream that ended early.
  const sse = src('lib/sse-stream.ts');
  assert.match(sse, /event\.delta\.type === 'input_json_delta'/);
  assert.match(sse, /if \(!sawStop && !stopReason\) throw new Error\('anthropic: the stream ended before the answer did'\);/);
});

test('the route relays each piece of text, and answers standby before the room is read', () => {
  const route = src('app/api/assistant/route.ts');
  assert.match(route, /\(delta\) => emit\(delta == null \? \{ line: true \} : \{ text: delta \}\)/);
  assert.match(route, /if \(onText\) onText\(null\);\s*const turn = await chatWithTools\(tm, snapshot, \{ tools: !standby, \.\.\.\(onText/);
  const start = route.indexOf('const livePromise = liveSituation(userId, page, focus);');
  const standby = route.indexOf('if (mode === "standby") {', start);
  const awaited = route.indexOf('const live = await livePromise;', start);
  assert.ok(start > 0 && standby > start && awaited > standby, 'standby and resume return before the live situation is awaited');
});

test('the panel shows the answer as it is written', () => {
  const panel = src('components/DraftingAssistant.tsx');
  assert.match(panel, /else if \(evt && typeof evt\.text === "string"\) \{ partial \+= evt\.text; setLiveText\(partial\); \}/);
  assert.match(panel, /else if \(evt && evt\.line\) \{ partial = ""; setLiveText\(""\); \}/, 'a fresh line after a tool');
  assert.match(panel, /\{busy && liveText && \(/);
  assert.match(panel, /scrollIntoView\(\{ block: "end" \}\)/, 'kept in view as it grows');
});

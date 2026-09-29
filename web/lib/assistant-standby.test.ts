import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_ONLY_RULES, OPENING_CHIPS, OPENING_LINE, STANDBY_ACK, standbyCommand } from './assistant-standby.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('standby and resume are recognised as whole messages, never inside a sentence', () => {
  for (const t of ['standby', 'Stand by.', 'go on standby', 'Standby mode', 'stay on standby please', 'STANDBY!']) {
    assert.equal(standbyCommand(t), 'standby', t);
  }
  for (const t of ['resume', 'Resume.', 'wake up', 'stand down', 'carry on', 'back to work']) {
    assert.equal(standbyCommand(t), 'resume', t);
  }
  assert.equal(standbyCommand('put the standby post on Friday'), null);
  assert.equal(standbyCommand('resume the batch you proposed'), null);
  assert.equal(standbyCommand(''), null);
  assert.equal(standbyCommand(null), null);
});

test('the opening line asks for a command and offers no fix', () => {
  assert.match(OPENING_LINE, /tell me what you want done/i);
  assert.ok(!OPENING_CHIPS.some((c) => /retry|fix/i.test(c)));
  assert.match(STANDBY_ACK, /will not act/);
  assert.match(COMMAND_ONLY_RULES, /ONLY on a command/);
  assert.match(COMMAND_ONLY_RULES, /do not offer to/i);
});

test('the panel opens without asking the server for a report, and outlines in blue while working', () => {
  const panel = src('components/DraftingAssistant.tsx');
  assert.doesNotMatch(panel, /if \(msgs\.length === 0\) send\(""\)/, 'no priming request on open');
  assert.match(panel, /OPENING_LINE/);
  assert.match(panel, /busy \? ['"][^'"]*ring-2 ring-accent/, 'the blue outline while a turn is in flight');
  assert.match(panel, /session\?\.standby/, 'the header shows standby');
  assert.match(panel, /m\.image/, 'a generated picture is shown in the thread');
});

test('the route puts the assistant on standby before anything else, and withholds its tools there', () => {
  const route = src('app/api/assistant/route.ts');
  const standbyAt = route.indexOf('standbyCommand(input)');
  const agentAt = route.indexOf('const out = await runAgent(');
  assert.ok(standbyAt > 0 && standbyAt < agentAt, 'standby is decided before the model is asked anything');
  assert.match(route, /session\.standby = true/);
  assert.match(route, /chatWithTools\(tm, snapshot, \{ tools: !standby \}\)/, 'no tools on a standby turn');
  assert.match(route, /STANDBY_RULES/);
  // The standing orders: command only, and the image tool.
  const ai = src('lib/ai.ts');
  assert.match(ai, /COMMAND_ONLY_RULES/);
  assert.doesNotMatch(ai, /Do not ask permission first/);
  assert.match(ai, /name: "generate_image"/);
  assert.match(route, /call\.name === "generate_image"/);
  assert.match(route, /ensureDraftImage\(/);
  // And it sees more than the video pipeline.
  assert.match(route, /workspaceBlock\(userId\)/);
});

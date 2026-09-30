import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_ONLY_RULES, CONVERSATION_RULE, NEXT_STEP_RULE, OPENING_CHIPS, OPENING_LINE, STANDBY_ACK, pageContext, splitNextStep, standbyCommand, stepLabel } from './assistant-standby.ts';

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
  assert.match(route, /chatWithTools\(tm, snapshot, \{ tools: !standby, /, 'no tools on a standby turn');
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

test('the assistant knows which screen the user is on, and offers what fits it', () => {
  assert.equal(pageContext('/sources/videos').label, 'Video Library');
  assert.match(pageContext('/sources/videos').chips[0], /video pipeline/);
  assert.equal(pageContext('/calendar/').label, 'Calendar / Publishing');
  assert.equal(pageContext('/').label, 'Dashboard');
  assert.deepEqual(pageContext(null).chips, OPENING_CHIPS);
  for (const p of ['/', '/draft', '/templates', '/calendar', '/brand', '/sources/videos', '/sources/images', '/sources/calendar']) {
    assert.ok(!pageContext(p).chips.some((c) => /retry|fix/i.test(c)), p + ' offers no fix');
  }
});

test('a trailing "Next:" line is split off as the step ahead, and only a trailing one', () => {
  assert.deepEqual(splitNextStep('Row 183 is prepared and has no Metricool draft.\n\nNext: send row 183 to Metricool for review.'), { text: 'Row 183 is prepared and has no Metricool draft.', next: 'send row 183 to Metricool for review' });
  assert.deepEqual(splitNextStep('**Next:** prepare row 184'), { text: '**Next:** prepare row 184', next: 'prepare row 184' });
  assert.deepEqual(splitNextStep('Nothing to suggest.'), { text: 'Nothing to suggest.', next: null });
  assert.deepEqual(splitNextStep(''), { text: '', next: null });
  assert.match(NEXT_STEP_RULE, /Never take that step unasked/);
});

test('the conversation survives a page change: the panel persists itself and the nav is client-side', () => {
  const panel = src('components/DraftingAssistant.tsx');
  assert.match(panel, /sessionStorage\.getItem\(STORE_KEY\)/);
  assert.match(panel, /writeStore\(\{ open, msgs, session, input \}\)/);
  assert.match(panel, /page: pathname/, 'where the user is goes with every message');
  assert.match(panel, /splitNextStep\(/, 'the step ahead becomes a chip');
  assert.match(src('components/PageNav.tsx'), /<Link/);
  assert.doesNotMatch(src('components/PageNav.tsx'), /<a\s/);
  const route = src('app/api/assistant/route.ts');
  assert.match(route, /WHERE THE USER IS: /);
  assert.match(route, /performanceBlock\(userId\)/, 'what has worked reaches every turn');
  assert.match(src('lib/ai.ts'), /NEXT_STEP_RULE/);
});

test('every activity has a label for the blue trail, named from its own input', () => {
  assert.equal(stepLabel('generate_content', { topic: 'NK cell therapy for immune support' }), 'Writing the draft \u201cNK cell therapy for immune support\u201d');
  assert.equal(stepLabel('competitor_comparables', { topic: 'stem cell treatment' }), 'Comparing with the top 3 on Google for \u201cstem cell treatment\u201d');
  assert.equal(stepLabel('pipeline_status', {}), 'Reading the video pipeline');
  assert.equal(stepLabel('generate_image', null), 'Making the picture');
  assert.match(stepLabel('generate_content', { topic: 'x'.repeat(80) }), /\u2026\u201d$/, 'a long topic is cut');
  assert.equal(stepLabel('some_new_tool', {}), 'Working on some new tool');
  assert.match(CONVERSATION_RULE, /colleague/);
});

test('the trail is streamed as it happens and shown in blue', () => {
  const route = src('app/api/assistant/route.ts');
  assert.match(route, /onStep\(stepLabel\(call\.name, call\.input\)\)/, 'each tool call is announced as it starts');
  assert.match(route, /application\/x-ndjson/);
  assert.match(route, /emit\(\{ step: label \}\)/);
  assert.match(route, /emit\(\{ done: payload \}\)/, 'and the answer comes last');
  const panel = src('components/DraftingAssistant.tsx');
  assert.match(panel, /Accept: "application\/x-ndjson"/);
  assert.match(panel, /res\.body\.getReader\(\)/);
  assert.match(panel, /text-accent/, 'in blue');
  assert.match(panel, /steps: trail\.length \? \[\.\.\.trail\] : null/, 'kept with the answer as a guide');
});

// web/lib/ai-focus.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { focusBlock } from '../components/aiFocus.ts';

test('what the user is pointing at reaches the model as a block that names the item and its id', () => {
  const b = focusBlock({ kind: 'draft', id: 'abc-123', label: 'Muscle strength and longevity', text: 'Not everyone needs the same vitamins…' });
  assert.match(b, /^WHAT THE USER IS POINTING AT/);
  assert.match(b, /a draft in Recent Drafts — id abc-123/);
  assert.match(b, /Title: Muscle strength and longevity/);
  assert.match(b, /Do not ask which one they mean/);
  assert.equal(focusBlock(null), '');
});

test('clicking with the panel open outlines the item in blue and sends it with the next message', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const panel = src('components/DraftingAssistant.tsx');
  assert.match(panel, /body: JSON\.stringify\(\{ session, text: clean, page: pathname, focus: getFocus\(\) \}\)/);
  assert.match(panel, /e\.altKey \|\| isPointing\(\)/, 'Alt-click anywhere, or "Point at something" then a click');
  assert.match(panel, /Point at something/);
  assert.match(css(), /\[data-ai-focused\]/);
  assert.match(css(), /outline: 2px solid var\(--accent\)/, 'in blue');
  const route = src('app/api/assistant/route.ts');
  assert.match(route, /focusBlock\(focus \?\? null\)/, 'the route puts it in front of the model');
  assert.match(route, /const focus = readFocus\(parsed\.focus\);/, 'shaped and cut to size on arrival');
  assert.match(src('components/useVoiceAssistant.ts'), /focus: getFocus\(\)/, 'the voice too');
  // The cards say what they are.
  assert.match(src('app/AutopilotQueue.tsx'), /data-ai-target="run" data-ai-id=\{r\.id\}/);
  assert.match(src('app/page.tsx'), /data-ai-target="draft"/);
  assert.match(src('app/calendar/page.tsx'), /data-ai-target="post"/);
  assert.match(src('components/StrategyDrop.tsx'), /data-ai-target="slot"/);
  function css() { return src('app/globals.css'); }
});

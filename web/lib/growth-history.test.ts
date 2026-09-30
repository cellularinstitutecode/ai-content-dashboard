import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROWTH_HISTORY, GROWTH_HISTORY_AS_OF } from './growth-history.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the lead history carries the numbers the team gave, dated', () => {
  assert.match(GROWTH_HISTORY, new RegExp(GROWTH_HISTORY_AS_OF));
  for (const fact of ['605 to 747', 'January 2025 \\(747\\)', '92 to 120', '541', '617', '19 September 2026', '1,635 contacts and 7 patients', '19%', '1\\.4%', '"CPI"', 'anti-aging']) {
    assert.match(GROWTH_HISTORY, new RegExp(fact), fact);
  }
  assert.match(GROWTH_HISTORY, /Leads are not patients/);
});

test('the assistant and the voice assistant both know it, and can compare with the competition', () => {
  assert.match(src('lib/playbook.ts'), /GROWTH_HISTORY/, 'in the cached playbook block');
  assert.match(src('app/api/realtime-session/route.ts'), /GROWTH_HISTORY/, 'and in the voice session');
  const ai = src('lib/ai.ts');
  assert.match(ai, /name: "competitor_comparables"/);
  assert.match(ai, /\| "competitor_comparables"/);
  const route = src('app/api/assistant/route.ts');
  assert.match(route, /call\.name === "competitor_comparables"/);
  assert.match(route, /serpCompetitors\(/, 'who ranks, from Semrush');
  assert.match(route, /topOrganicKeywords\(/, 'and what each of them ranks for');
  // Voice acts through the text assistant, with the page it is on.
  const voice = src('components/useVoiceAssistant.ts');
  assert.match(voice, /page: window\.location\.pathname/);
  assert.match(src('app/api/realtime-session/route.ts'), /call run_command at once/i);
});

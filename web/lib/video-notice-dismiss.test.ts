import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the video page’s "Last run" notice can be closed once the run has stopped', () => {
  const panel = src('components/VideoPrepare.tsx');
  assert.match(panel, /\{!batchRunning && onDismissBatch && \(\s*<button type="button" onClick=\{onDismissBatch\} aria-label="Close this notice"/, 'an × while nothing is running');
  // Closing clears the stored run, so the notice and its row notes stay gone after a reload.
  const view = src('components/SourcesView.tsx');
  assert.match(view, /onDismissBatch=\{\(\) => setBatch\(\{\}\)\}/);
  assert.match(view, /window\.localStorage\.setItem\(BASKET_KEY, JSON\.stringify\(\{ picked: Array\.from\(picked\), batch,/, 'the cleared run is what gets stored');
});

// web/lib/draft-image-step.test.ts
//
// The hero image is generated when the post is WRITTEN, not when somebody
// opens the queue. Source checks, because lib/autopilot.ts imports
// `server-only` and the test runner cannot load it.
//
// What these hold in place: the call is inside stepDraft, it is guarded by the
// networks that actually refuse a text-only post, and it cannot fail the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NETWORKS_NEEDING_MEDIA } from './composer.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

function stepDraftBody(): string {
  const autopilot = src('lib/autopilot.ts');
  const start = autopilot.indexOf('async function stepDraft(');
  assert.ok(start > 0, 'stepDraft is gone — has it been renamed?');
  const end = autopilot.indexOf('export function scorePack(', start);
  assert.ok(end > start, 'could not find the end of stepDraft');
  return autopilot.slice(start, end);
}

test('the image is generated inside stepDraft', () => {
  // It used to happen only if a reviewer opened the queue, or at approve —
  // where it sits in a catch that never blocks approval. Neither runs when
  // nobody is in the loop, and Instagram refuses a post with no picture.
  assert.match(stepDraftBody(), /await ensureDraftImage\(draftId, run\.user_id\)/);
});

test('and only for networks that refuse a text-only post', () => {
  // A LinkedIn-only or blog-only template must not spend an image credit.
  const body = stepDraftBody();
  assert.match(body, /NETWORKS_NEEDING_MEDIA\.has/, 'the guard must read the composer set, not a list typed here');
  assert.match(body, /if \(needsImage && draftId\)/);
  // The set this depends on, asserted so a change over there is visible here.
  assert.equal(NETWORKS_NEEDING_MEDIA.has('instagram'), true);
  assert.equal(NETWORKS_NEEDING_MEDIA.has('linkedin'), false);
  assert.equal(NETWORKS_NEEDING_MEDIA.has('blog'), false);
});

test('a failed image is a line in the log, never a failed run', () => {
  const body = stepDraftBody();
  const call = body.slice(body.indexOf('if (needsImage && draftId)'));
  assert.match(call.slice(0, 600), /try \{/, 'the call must be wrapped');
  assert.match(call.slice(0, 900), /reportError\('autopilot:draft-image'/, 'and the failure reported');
  // The run still advances: the state returned below is unconditional.
  assert.match(body, /state: 'drafted'/);
  // And the card says what happened, rather than simply having no picture.
  assert.match(body, /imageNote/);
  assert.match(body, /could not be generated/);
});

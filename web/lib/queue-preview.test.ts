// The Dashboard's publishing queue: a Preview button to the LEFT of Approve,
// so nobody approves a post from a two-line excerpt. It opens the whole post
// (picture or video, full caption, channels, time, sheet row) with the same
// Approve / Publish now / Continue the row has.
//
// Source assertions: app/page.tsx is a client page the test runner cannot load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

test('every queue row has Preview, and it sits before Approve', () => {
  const row = page.slice(page.indexOf('<span className="ml-auto flex items-center gap-3">'));
  const preview = row.indexOf('onClick={() => setPreviewPostId(id)}');
  const approve = row.indexOf('onClick={() => approvePost(p)}');
  assert.ok(preview > 0, 'the Preview button is on the row');
  assert.ok(approve > preview, 'and to the left of Approve');
  // Outside the "waiting for approval" branch: a post already approved, or
  // waiting on its video, can be previewed too.
  assert.ok(row.indexOf("{meta.label === 'Waiting for your approval' && !pending && (") > preview);
});

test('the caption opens the preview too', () => {
  assert.match(page, /onClick=\{\(\) => id && setPreviewPostId\(id\)\} title="Preview this post"/);
});

test('the preview shows what goes out and acts through the row\'s own functions', () => {
  const modal = page.slice(page.indexOf('const pp: any = previewPostId'));
  assert.match(modal, /<video src=\{pp\.mediaUrl\}/, 'the video');
  assert.match(modal, /<img src=\{pp\.imageUrl\}/, 'or the picture');
  assert.match(modal, /whitespace-pre-wrap[^>]*>\{pp\.text/, 'the whole caption');
  assert.match(modal, /networkLabel\(n\)/, 'the channels');
  assert.match(modal, /approvePost\(pp\)/, 'Approve, with its confirm');
  assert.match(modal, /approvePost\(pp, true\)/, 'Publish now');
  assert.match(modal, /continueDraft\(pp\)/, 'Continue');
  // Read from the live list, so an approve or delete elsewhere closes it.
  assert.match(modal, /safePosts\.find\(\(x: any\) => String\(x\?\.id \|\| ''\) === previewPostId\)/);
  assert.match(page, /if \(e\.key === 'Escape'\) setPreviewPostId\(null\)/, 'Escape closes it');
});

test('Edit opens the picture editor: AI remake with notes, title, library photo', () => {
  const modal = page.slice(page.indexOf('const pp: any = previewPostId'));
  assert.match(modal, /const ppCanEdit = Boolean\(pp\.draft_id\) && !pp\.mediaUrl;/, 'a picture post with a draft behind it');
  assert.match(modal, /setPreviewEditingId\(previewEditing \? null : ppId\)/, 'the Edit button toggles the section');
  // The same editor the Calendar preview uses (it carries ImageEditPanel:
  // notes for the picture + "Regenerate with these notes").
  assert.match(modal, /<HeroImageControls\s+draftId=\{String\(pp\.draft_id\)\}/);
  assert.match(modal, /onChanged=\{\(\) => afterQueueImageChanged\(pp\)\}/);
  // A post already in Metricool asks first, then gets the new picture there too.
  assert.match(modal, /beforeChange=\{\(\) => !pp\.metricool_post_id \|\| window\.confirm/);
  const sync = page.slice(page.indexOf('async function afterQueueImageChanged('));
  assert.match(sync.slice(0, 900), /action: 'sync_media'/);
  assert.match(page, /const previewEditing = previewPostId != null && previewEditingId === previewPostId;/, 'closed again for each new preview');
});

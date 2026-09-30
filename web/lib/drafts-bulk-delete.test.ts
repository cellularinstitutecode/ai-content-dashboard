// web/lib/drafts-bulk-delete.test.ts
// Recent Drafts: several at once. Source checks — the page and the route both
// import server-only or React, so what is asserted is the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the drafts route deletes several ids exactly as it deletes one', () => {
  const route = src('app/api/drafts/route.ts');
  const del = route.slice(route.indexOf('export async function DELETE'));
  assert.match(del, /searchParams\.get\('ids'\)/, 'accepts ?ids=a,b,c');
  assert.match(del, /searchParams\.get\('id'\)/, 'and still ?id=one');
  assert.match(del, /for \(const id of ids\) \{/);
  // Each one: read the pack, delete the row, remove its images — never a bare row delete.
  assert.match(del, /\.select\('pack'\)[\s\S]{0,300}\.maybeSingle\(\);[\s\S]{0,600}\.delete\(\)[\s\S]{0,700}removeDraftImages\(pack\)/);
  // Always the caller's own rows.
  assert.equal((del.match(/\.eq\('user_id', user\.id\)/g) || []).length >= 2, true);
  // One failure does not stop the rest, and the answer says which failed.
  assert.match(del, /failed\.push\(\{ id, error: error\.message \}\); continue;/);
  assert.match(del, /NextResponse\.json\(\{ ok: true, deleted, failed, kept \}\)/);
  assert.match(del, /MAX_BULK_DELETE/);
  // "except approved": a draft whose post a person approved (or that went out) is kept and reported.
  assert.match(del, /searchParams\.get\('keepApproved'\)/);
  assert.match(del, /if \(protectedIds\.has\(id\)\) \{ kept\.push\(id\); continue; \}/);
  assert.match(route, /const APPROVED_LIKE = new Set\(\[APPROVED_STATUS, 'published', 'sent', 'live'\]\);/);
  // And the list says which drafts those are.
  assert.match(route, /approved: true \}/);
});

test('Recent Drafts has a checkbox per draft and one Delete for the ticked ones', () => {
  const page = src('app/page.tsx');
  assert.match(page, /aria-label="Select this draft"[\s\S]{0,200}onClick=\{\(e\) => e\.stopPropagation\(\)\}/, 'ticking a box does not open the draft');
  assert.match(page, /aria-label="Select all drafts shown"/);
  // Two ways to delete when approved posts are among the ticked: keep them, or take them too.
  assert.match(page, /'Delete ' \+ scope \+ ' except approved \(' \+ \(pickedHere\.length - approvedPicked\) \+ '\)'/);
  assert.match(page, /'Delete ' \+ scope \+ ', approved included \(' \+ pickedHere\.length \+ '\)'/);
  assert.match(page, /const scope = allPicked \? 'all' : 'selected';/, '"Delete all …" when everything shown is ticked');
  const fn = page.slice(page.indexOf('async function deleteSelectedDrafts'), page.indexOf('function cleanCaption'));
  assert.match(fn, /window\.confirm\(/, 'asks first');
  // In rounds of a hundred: one request of 141 was refused whole.
  assert.match(fn, /for \(let i = 0; i < ids\.length; i \+= BULK_DELETE_CHUNK\)/);
  assert.match(fn, /\(mode === 'keep-approved' \? '&keepApproved=1' : ''\)/);
  // The outcome is said in the panel, beside the buttons — never at the top of the page.
  assert.match(fn, /setDraftsMsg\(\{ text: parts\.join\(' '\), bad: failed\.length > 0 \}\)/);
  assert.doesNotMatch(fn, /setActionMsg\(/);
  assert.match(page, /\{draftsMsg && \(/);
  assert.match(fn, /setPickedDrafts\(new Set\(failed\.map/, 'what could not be deleted stays ticked for a retry');
  assert.match(fn, /announce\('drafts', 'stats', 'images'\)/, 'the list and the counters reload');
  // The per-row Delete is still there.
  assert.match(page, /aria-label="Delete draft"/);
});

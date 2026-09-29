// web/lib/publishing-list.test.ts
// The Autopilot drafts join the Calendar / Publishing list, in date order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { complianceLines, mergeByDate, reviewRuns, runChannels, runText } from './publishing-list.ts';

const NOW = new Date('2026-09-28T12:00:00Z').getTime();

test('only runs waiting for a decision are listed, split by whether their time has gone', () => {
  const runs = [
    { id: 'a', state: 'ready_for_review', scheduled_for: '2026-09-30T09:00:00Z' },
    { id: 'b', state: 'ready_for_review', scheduled_for: '2026-09-29T09:00:00Z' },
    { id: 'c', state: 'approved', scheduled_for: '2026-09-29T10:00:00Z' },
    { id: 'd', state: 'skipped', scheduled_for: '2026-09-29T11:00:00Z' },
    { id: 'e', state: 'drafted', scheduled_for: '2026-09-29T12:00:00Z' },
    { id: 'f', state: 'failed', scheduled_for: '2026-09-29T13:00:00Z' },
    { id: 'g', state: 'ready_for_review', scheduled_for: '2026-09-20T09:00:00Z' },
  ];
  const { upcoming, missed } = reviewRuns(runs, NOW);
  assert.deepEqual(upcoming.map((r) => r.id), ['b', 'a'], 'soonest first');
  assert.deepEqual(missed.map((r) => r.id), ['g']);
});

test('the API’s own missed flag wins over the clock', () => {
  // The route decides "missed" with a margin (lib/review-queue.ts); the page
  // must agree with it, not re-derive a different answer.
  const runs = [
    { id: 'soon', state: 'ready_for_review', scheduled_for: '2026-09-28T12:02:00Z', missed: true },
    { id: 'late', state: 'ready_for_review', scheduled_for: '2026-09-28T11:00:00Z', missed: false },
  ];
  const { upcoming, missed } = reviewRuns(runs, NOW);
  assert.deepEqual(missed.map((r) => r.id), ['soon']);
  assert.deepEqual(upcoming.map((r) => r.id), ['late']);
  assert.deepEqual(reviewRuns(null, NOW), { upcoming: [], missed: [] });
});

test('posts and runs share one order, soonest first', () => {
  const posts = [
    { id: 'p2', publication_date: '2026-09-30T09:00:00Z' },
    { id: 'p1', publication_date: '2026-09-29T09:00:00Z' },
  ];
  const runs = [
    { id: 'r1', state: 'ready_for_review', scheduled_for: '2026-09-29T18:00:00Z' },
    { id: 'r0', state: 'ready_for_review', scheduled_for: '2026-09-29T09:00:00Z' },
  ];
  const order = mergeByDate(posts, runs).map((e) => (e.kind === 'post' ? e.post.id : e.run.id));
  assert.deepEqual(order, ['p1', 'r0', 'r1', 'p2'], 'a post sorts before a run at the same minute');
});

test('a run’s copy comes from its pack, first channel with text', () => {
  const pack = { instagram: '  ', facebook: 'Hello from Facebook', linkedin: 'On LinkedIn', _image: { url: 'x' } };
  assert.deepEqual(runChannels(pack), ['facebook', 'linkedin']);
  assert.equal(runText(pack), 'Hello from Facebook');
  assert.equal(runText(null), '');
  assert.deepEqual(runChannels(undefined), []);
});

test('the REF and AVISO lines are lifted out of the caption as written', () => {
  const text = 'Body of the post.\n\nREF: Smith et al. 2024, doi 10.1000/xyz\nAVISO DE PUBLICIDAD: 2623022002A00090';
  assert.deepEqual(complianceLines(text), {
    ref: 'REF: Smith et al. 2024, doi 10.1000/xyz',
    aviso: 'AVISO DE PUBLICIDAD: 2623022002A00090',
  });
  assert.deepEqual(complianceLines('No lines here'), { ref: null, aviso: null });
  assert.deepEqual(complianceLines('Referencia: a study\n'), { ref: 'Referencia: a study', aviso: null });
});

// --- THE PAGE USES IT ------------------------------------------------------

test('the calendar lists the Autopilot drafts and approves them through the Dashboard’s own route', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const page = src('app/calendar/page.tsx');
  assert.match(page, /fetch\('\/api\/autopilot\/runs'\)/, 'the same list the Dashboard queue reads');
  assert.match(page, /reviewRuns\(runs/, 'and the same subset it shows as ready');
  assert.match(page, /mergeByDate\(/, 'sorted with the posts by date');
  assert.match(page, /action: 'approve'/, 'approve goes through POST /api/autopilot/runs');
  assert.doesNotMatch(page, /approveRun\(/, 'the page never approves on its own');

  // The same words the Dashboard uses before a post is scheduled.
  const queue = src('app/AutopilotQueue.tsx');
  const confirmLine = /Approve and schedule this post\?\\n\\nIt will be published at ' \+ fmtSlot\(r\.scheduled_for\) \+ ' \(clinic time\)\. Metricool does the publishing; you will not need to open it\./;
  assert.match(queue, confirmLine);
  assert.match(page, /Approve and schedule this post\?\\n\\nIt will be published at ' \+ fmtScheduleSlot\(run\.scheduled_for\) \+ ' \(clinic time\)\. Metricool does the publishing; you will not need to open it\./);

  const preview = src('components/RunPreview.tsx');
  assert.match(preview, /Autopilot · needs approval/, 'visibly not a Metricool post yet');
  assert.match(preview, /complianceLines\(/, 'the REF and AVISO lines are shown');
  assert.match(preview, /citationLabel\(/, 'and the citation verdict, as on the Dashboard');
  assert.match(preview, /claimSupportNote\(/);
  assert.match(preview, /imageUnshippable\(/);
  // A missed run offers Skip only: its time has gone and Metricool refuses a past date.
  assert.match(preview, /run\.missed \? null :/);
});

test('changing a post’s picture re-sends it to Metricool through the existing replace', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/posts/route.ts');
  assert.match(route, /\['reschedule', 'approve', 'publish_now', 'attach_video', 'sync_media'\]/);
  const sync = route.indexOf("else if (action === 'sync_media')");
  const approve = route.indexOf("mode = 'scheduled'");
  const replace = route.indexOf('await metricoolReplacePost(');
  assert.ok(sync > -1 && sync < approve, 'sync_media is its own branch, above the approve path — never an approval');
  assert.ok(approve < replace, 'and reaches the one replace call every change uses');
  // No second scheduler call was added: the media travels with the replace.
  assert.equal((route.match(/metricoolReplacePost\(/g) || []).length, 1, 'the one call');

  const page = src('app/calendar/page.tsx');
  assert.match(page, /action: 'sync_media'/);
  assert.match(page, /post\.metricool_post_id && !post\.mediaUrl/, 'only a post already in Metricool, and never in front of its video');

  const controls = src('components/HeroImageControls.tsx');
  assert.match(controls, /regenerate: true/, 'New AI image is the Dashboard’s regenerate');
  assert.match(controls, /action: 'import_image'/, 'a library photo is copied the way "Use as hero image" copies it');
  assert.match(controls, /useUrl: url/);
  assert.match(controls, /brandPhotoUrl: url/, 'the same photo with the brand filter and the title — never an AI take');
  assert.doesNotMatch(controls, /styleFromUrl/);
});

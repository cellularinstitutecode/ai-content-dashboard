import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparable, isLivePost, metricMatchesRun, strategyPerformance, type PerfMetric, type PerfRun } from './strategy-performance.ts';

const SLEEP = 'Eight hours in bed is not the same as rest. Quality matters more than length for most of us.\n\nSave this for tonight.\nREF: Smith (2020). DOI: 10.1/x\nAVISO DE PUBLICIDAD';
const MOVE = 'A short walk after dinner is one of the simplest habits to keep, and it adds up over a week.\n\nShare this.';

/** A run and the posts it sent: [network, text, at]. */
const run = (id: string, slot: string, when: string, sent: [string, string, string?][], angle: Record<string, string> = {}): PerfRun =>
  ({ id, slot, scheduled_for: when, angle, sent: sent.map(([network, text, at]) => ({ network, text, at: at || when })) });
const metric = (network: string, text: string, published_at: string | null, engagement: number, impressions = 100): PerfMetric =>
  ({ network, text, published_at, engagement, impressions });

test('a caption is compared as plain words, without links, hashtags or accents', () => {
  assert.equal(comparable('¡Cancún, #travel https://x.y/z  now!'), 'cancun now');
});

test('a metric matches the post the run sent on that network, near when it went out', () => {
  const r = run('r1', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP], ['facebook', SLEEP]]);
  assert.ok(metricMatchesRun(r, metric('Instagram', SLEEP.replace('\n\n', ' ') + ' #sleep', '2026-10-07T23:05:00Z', 40)));
  assert.ok(!metricMatchesRun(r, metric('instagram', SLEEP, '2026-11-20T23:05:00Z', 40)), 'weeks later is another post');
  assert.ok(!metricMatchesRun(r, metric('instagram', MOVE, '2026-10-07T23:05:00Z', 40)));
  assert.ok(!metricMatchesRun(r, metric('instagram', 'Eight hours', '2026-10-07T23:05:00Z', 40)), 'too little to compare is not a match');
});

test('the window follows the post, not the slot: a reschedule a week later still matches', () => {
  const r = run('r1', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP, '2026-10-15T23:00:00Z']]);
  assert.ok(metricMatchesRun(r, metric('instagram', SLEEP, '2026-10-15T23:01:00Z', 5)));
  assert.ok(!metricMatchesRun(r, metric('instagram', SLEEP, '2026-10-07T23:01:00Z', 5)), 'the old slot time is not when it went out');
});

test('a metric that names no network (or one the run did not use) can still match on caption and date', () => {
  const r = run('r1', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP]]);
  assert.ok(metricMatchesRun(r, metric('unknown', SLEEP, '2026-10-07T23:05:00Z', 3)));
  assert.ok(metricMatchesRun(r, metric('tiktok', SLEEP, '2026-10-07T23:05:00Z', 3)));
  assert.ok(!metricMatchesRun(r, metric('unknown', MOVE, '2026-10-07T23:05:00Z', 3)));
  // When the run did post to that network, only that post's text counts.
  const two = run('r2', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP], ['facebook', MOVE]]);
  assert.ok(!metricMatchesRun(two, metric('facebook', SLEEP, '2026-10-07T23:05:00Z', 3)));
});

test('only approved posts that are due count as live', () => {
  const now = new Date('2026-10-10T00:00:00Z').getTime();
  assert.ok(isLivePost({ status: 'approved', publication_date: '2026-10-09T14:00:00Z' }, now));
  assert.ok(!isLivePost({ status: 'pending_review', publication_date: '2026-10-09T14:00:00Z' }, now), 'a Metricool draft');
  assert.ok(!isLivePost({ status: 'approved', publication_date: '2026-10-11T14:00:00Z' }, now), 'still to come');
  assert.ok(!isLivePost({ status: 'approved', publication_date: null }, now));
});

test('numbers are summed per run and counted in every row its slot belongs to; unsent runs are not counted', () => {
  const runs = [
    // mon-1 is Diagnosis (assessment-prevention) with follow-up integrated.
    run('a', 'mon-1', '2026-10-05T14:00:00Z', [['instagram', SLEEP], ['facebook', SLEEP]], { query: 'Angle A', format: 'checklist' }),
    run('b', 'sat-1', '2026-10-10T14:00:00Z', [['instagram', MOVE]], { query: 'Angle B', format: 'explainer' }),
    run('c', 'mon-1', '2026-10-12T14:00:00Z', [['instagram', 'Never measured, a caption long enough to compare with anything at all.']], { query: 'Angle C', format: 'checklist' }),
    run('draft-only', 'mon-1', '2026-10-19T14:00:00Z', [], { query: 'Angle D', format: 'checklist' }),
  ];
  const metrics = [
    metric('instagram', SLEEP, '2026-10-05T14:01:00Z', 30, 500),
    metric('facebook', SLEEP, '2026-10-05T14:01:00Z', 10, 200),
    metric('instagram', MOVE, '2026-10-10T14:02:00Z', 5, 90),
    metric('instagram', 'Somebody else entirely, a caption from a different post altogether.', '2026-10-06T10:00:00Z', 99),
  ];
  const perf = strategyPerformance(runs, metrics);
  const diag = perf.pillars.find((p) => p.id === 'assessment-prevention')!;
  assert.equal(diag.posts, 2, 'the run that sent nothing is not "published"');
  assert.equal(diag.measured, 1);
  assert.equal(diag.engagement, 40);
  assert.equal(diag.avgEngagement, 40);
  assert.deepEqual(diag.best, { angle: 'Angle A', engagement: 40 });
  assert.equal(perf.pillars.find((p) => p.id === 'follow-up')!.posts, 2, 'integrated rows count it too');
  const checklist = perf.formats.find((f) => f.format === 'checklist')!;
  assert.equal(checklist.posts, 2);
  assert.equal(checklist.measured, 1);
  assert.deepEqual(perf.totals, { posts: 3, measured: 2, metricsRead: 4, metricsMatched: 3 });
  assert.equal(perf.pillars.find((p) => p.id === 'cancun')!.avgEngagement, null, 'nothing measured is not zero');
});

test('one metric row is never counted for two runs', () => {
  const runs = [
    run('old', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP]]),
    run('new', 'sun-1', '2026-10-08T14:00:00Z', [['instagram', SLEEP]]),
  ];
  const perf = strategyPerformance(runs, [metric('instagram', SLEEP, '2026-10-08T14:01:00Z', 12)]);
  assert.equal(perf.totals.metricsMatched, 1);
  assert.equal(perf.totals.measured, 1);
});

test('the article is its own line, measured by its promos', () => {
  const perf = strategyPerformance([run('blog', 'mon-blog', '2026-10-05T16:00:00Z', [['facebook', MOVE, '2026-10-05T16:10:00Z']])], [metric('facebook', MOVE, '2026-10-05T16:11:00Z', 7)]);
  assert.equal(perf.article.measured, 1);
  assert.equal(perf.article.engagement, 7);
});

test('the same post stored twice is counted once, with its freshest numbers', () => {
  const runs = [run('r', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP]])];
  const perf = strategyPerformance(runs, [
    metric('Instagram', SLEEP, '2026-10-07T23:01:00Z', 12, 300),
    metric('unknown', SLEEP, '2026-10-07T23:01:00Z', 9, 250),
  ]);
  assert.equal(perf.pillars.find((p) => p.id === 'sleep-stress')!.engagement, 12);
  assert.equal(perf.totals.metricsMatched, 1, 'the duplicate copy is not counted');
  // Two different networks of one run still add up.
  const both = strategyPerformance([run('r', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP], ['facebook', SLEEP]])], [
    metric('instagram', SLEEP, '2026-10-07T23:01:00Z', 12),
    metric('facebook', SLEEP, '2026-10-07T23:01:00Z', 4),
  ]);
  assert.equal(both.totals.measured, 1);
  assert.equal(both.pillars.find((p) => p.id === 'sleep-stress')!.engagement, 16);
});

test('a Metricool draft counts once Metricool has numbers for it — not before', () => {
  const pending = (id: string) => ({ ...run(id, 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP]]), sent: [{ network: 'instagram', text: SLEEP, at: '2026-10-07T23:00:00Z', live: false }] });
  const unmeasured = strategyPerformance([pending('p')], []);
  assert.equal(unmeasured.totals.posts, 0);
  const measured = strategyPerformance([pending('p')], [metric('instagram', SLEEP, '2026-10-07T23:02:00Z', 6)]);
  assert.equal(measured.totals.posts, 1);
  assert.equal(measured.totals.measured, 1);
});

test('sentRowState: live, a due Metricool draft, or not counted', async () => {
  const { sentRowState } = await import('./strategy-performance.ts');
  const now = new Date('2026-10-10T00:00:00Z').getTime();
  assert.equal(sentRowState({ status: 'approved', publication_date: '2026-10-09T00:00:00Z' }, now), 'live');
  assert.equal(sentRowState({ status: 'pending_review', publication_date: '2026-10-09T00:00:00Z' }, now), 'pending');
  assert.equal(sentRowState({ status: 'pending_review', publication_date: '2026-10-11T00:00:00Z' }, now), null);
  assert.equal(sentRowState({ status: 'scheduled', publication_date: '2026-10-09T00:00:00Z' }, now), null);
});

test('two posts that opened alike keep their own numbers: each metric goes to the post sent closest to it', () => {
  const runs = [
    run('older', 'wed-2', '2026-10-07T23:00:00Z', [['instagram', SLEEP]]),
    run('newer', 'sun-1', '2026-10-09T14:00:00Z', [['instagram', SLEEP]]),
  ];
  const perf = strategyPerformance(runs, [
    metric('instagram', SLEEP, '2026-10-07T23:03:00Z', 20),
    metric('instagram', SLEEP, '2026-10-09T14:02:00Z', 7),
  ]);
  assert.equal(perf.totals.measured, 2, 'neither run loses its metric to the other');
  assert.equal(perf.pillars.find((p) => p.id === 'sleep-stress')!.engagement, 20 + 7);
});

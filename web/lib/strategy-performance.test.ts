import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparable, metricMatchesRun, strategyPerformance, textsOfPack, type PerfMetric, type PerfRun } from './strategy-performance.ts';

const SLEEP = 'Eight hours in bed is not the same as rest. Quality matters more than length for most of us.\n\nSave this for tonight.\nREF: Smith (2020). DOI: 10.1/x';
const MOVE = 'A short walk after dinner is one of the simplest habits to keep, and it adds up over a week.\n\nShare this.';

const run = (id: string, slot: string, when: string, texts: Record<string, string>, angle: Record<string, string> = {}): PerfRun =>
  ({ id, slot, scheduled_for: when, texts, angle });
const metric = (network: string, text: string, published_at: string, engagement: number, impressions = 100): PerfMetric =>
  ({ network, text, published_at, engagement, impressions });

test('a caption is compared as plain words, without links, hashtags or accents', () => {
  assert.equal(comparable('¡Cancún, #travel https://x.y/z  now!'), 'cancun now');
});

test('a metric matches the run that wrote that caption, on that network, near its slot', () => {
  const r = run('r1', 'wed-2', '2026-10-07T23:00:00Z', { instagram: SLEEP, facebook: SLEEP });
  assert.ok(metricMatchesRun(r, metric('Instagram', SLEEP.replace('\n\n', ' ') + ' #sleep', '2026-10-07T23:05:00Z', 40)));
  assert.ok(!metricMatchesRun(r, metric('linkedin', SLEEP, '2026-10-07T23:05:00Z', 40)), 'the run did not post to LinkedIn');
  assert.ok(!metricMatchesRun(r, metric('instagram', SLEEP, '2026-11-20T23:05:00Z', 40)), 'weeks later is another post');
  assert.ok(!metricMatchesRun(r, metric('instagram', MOVE, '2026-10-07T23:05:00Z', 40)));
  assert.ok(!metricMatchesRun(r, metric('instagram', 'Eight hours', '2026-10-07T23:05:00Z', 40)), 'too little to compare is not a match');
});

test('numbers are summed per run and counted in every row its slot belongs to', () => {
  const runs = [
    // mon-1 is Diagnosis (assessment-prevention) with follow-up integrated.
    run('a', 'mon-1', '2026-10-05T14:00:00Z', { instagram: SLEEP, facebook: SLEEP }, { query: 'Angle A', format: 'checklist' }),
    run('b', 'sat-1', '2026-10-10T14:00:00Z', { instagram: MOVE }, { query: 'Angle B', format: 'explainer' }),
    run('c', 'mon-1', '2026-10-12T14:00:00Z', { instagram: 'Never measured, a caption long enough to compare with anything at all.' }, { query: 'Angle C', format: 'checklist' }),
  ];
  const metrics = [
    metric('instagram', SLEEP, '2026-10-05T14:01:00Z', 30, 500),
    metric('facebook', SLEEP, '2026-10-05T14:01:00Z', 10, 200),
    metric('instagram', MOVE, '2026-10-10T14:02:00Z', 5, 90),
    metric('instagram', 'Somebody else entirely, a caption from a different post altogether.', '2026-10-06T10:00:00Z', 99),
  ];
  const perf = strategyPerformance(runs, metrics);
  const diag = perf.pillars.find((p) => p.id === 'assessment-prevention')!;
  assert.equal(diag.posts, 2);
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
    run('old', 'wed-2', '2026-10-07T23:00:00Z', { instagram: SLEEP }),
    run('new', 'sun-1', '2026-10-08T14:00:00Z', { instagram: SLEEP }),
  ];
  const perf = strategyPerformance(runs, [metric('instagram', SLEEP, '2026-10-08T14:01:00Z', 12)]);
  assert.equal(perf.totals.metricsMatched, 1);
  assert.equal(perf.totals.measured, 1);
});

test('the article is its own line, and textsOfPack reads only channel copy', () => {
  const perf = strategyPerformance([run('blog', 'mon-blog', '2026-10-05T16:00:00Z', { facebook: MOVE })], [metric('facebook', MOVE, '2026-10-05T16:10:00Z', 7)]);
  assert.equal(perf.article.measured, 1);
  assert.equal(perf.article.engagement, 7);
  assert.deepEqual(textsOfPack({ instagram: 'a', facebook: '', blog: 'b', _image: {} }), { instagram: 'a' });
});

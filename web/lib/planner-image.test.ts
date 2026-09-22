import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILLARS } from './content-strategy.ts';
import { PILLAR_SCENES, cleanTopic, plannerImageFor, plannerPromptLines, onTopicCheck } from './planner-image.ts';

const pack = (template_name: string, query: string) => ({ _autopilot: { template_name, angle: { query, seedTopic: query } } });

test('every strategy pillar has scenes', () => {
  for (const p of PILLARS) assert.ok(PILLAR_SCENES[p.id]?.scenes.length >= 3, p.id);
});

test('a planner draft is pictured from its pillar and angle, square for social', () => {
  const p = plannerImageFor(pack('Sleep', 'Why sleeping longer does not always mean resting better'));
  assert.ok(p);
  assert.equal(p!.pillarId, 'sleep');
  assert.equal(p!.clinic, false);
  assert.equal(p!.size, '1024x1024');
  const lines = plannerPromptLines(p!, 0).join(' ');
  assert.match(lines, /resting better/);
  assert.match(lines, /NOT inside the clinic/);
  assert.match(onTopicCheck(p!), /onTopic/);
});

test('the weekly article gets a landscape clinic scene', () => {
  const p = plannerImageFor(pack('Weekly article', 'Why effective care begins with a thorough evaluation'));
  assert.equal(p?.size, '1536x1024');
  assert.equal(p?.clinic, true);
});

test('drafts without planner provenance are left alone', () => {
  assert.equal(plannerImageFor({ instagram: 'x' }), null);
  assert.equal(plannerImageFor(null), null);
  assert.equal(plannerImageFor(pack('My own template', 'x')), null);
});

test('scenes rotate and the autopilot prefix is stripped', () => {
  const p = plannerImageFor(pack('Nutrition', '[Autopilot] The role of protein in recovery'))!;
  assert.equal(p.subject, 'The role of protein in recovery');
  assert.notEqual(plannerPromptLines(p, 0)[1], plannerPromptLines(p, 1)[1]);
  assert.equal(cleanTopic('[Autopilot] Sleep'), 'Sleep');
});

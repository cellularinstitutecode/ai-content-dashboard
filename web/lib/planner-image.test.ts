import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILLARS } from './content-strategy.ts';
import { BLOG_ANGLES } from './strategy-seed.ts';
import { PILLAR_SCENES, TITLES, cleanTopic, plannerImageFor, plannerPromptLines, onTopicCheck, titleFor } from './planner-image.ts';

const pack = (template_name: string, query: string) => ({ _autopilot: { template_name, angle: { query, seedTopic: query } } });

test('every strategy pillar has three consultation scenes and an on-topic cue', () => {
  for (const p of PILLARS) {
    const s = PILLAR_SCENES[p.id];
    assert.ok(s && s.scenes.length >= 3, p.id);
    assert.ok(s.mustShow.length > 20, p.id);
  }
});

test('every angle the strategy lists has a short, hand-written cover title', () => {
  const angles = [...PILLARS.flatMap((p) => p.angles), ...BLOG_ANGLES];
  for (const a of angles) {
    const t = TITLES[a];
    assert.ok(t, 'no title for: ' + a);
    assert.ok(t.length <= 40, 'title too long for a cover: ' + t);
  }
});

test('a planner draft is pictured as a consultation on its pillar, portrait, with its title', () => {
  const p = plannerImageFor(pack('Nutrition', 'The role of protein in recovery'));
  assert.ok(p);
  assert.equal(p!.pillarId, 'nutrition');
  assert.equal(p!.size, '1024x1536');
  assert.equal(p!.title, 'Protein and Recovery');
  const lines = plannerPromptLines(p!, 0).join(' ');
  assert.match(lines, /medical consultation/);
  assert.match(lines, /oranges/);
  assert.match(lines, /upper 40% of the frame is EMPTY/);
  assert.match(lines, /head must sit BELOW the middle/);
  assert.match(lines, /white or cream blazer/);
  assert.doesNotMatch(lines, /black scrubs/);
  assert.match(onTopicCheck(p!), /onTopic/);
});

test('a team direction replaces the scene but keeps the title space and the look', () => {
  const p = plannerImageFor(pack('Sleep', 'Simple habits that may improve sleep quality'))!;
  const lines = plannerPromptLines(p, 0, 'a couple at the table').join(' ');
  assert.match(lines, /Direction from the team.*a couple at the table/);
  assert.doesNotMatch(lines, /Scene:/);
  assert.match(lines, /upper 40%/);
});

test('the weekly article borrows the scenes of the pillar its angle came from', () => {
  const p = plannerImageFor(pack('Weekly article', 'How follow-ups at 1, 3, 6, and 12 months support continuity of care'));
  assert.equal(p?.pillarId, 'article');
  assert.equal(p?.scenes, PILLAR_SCENES['follow-up'].scenes);
  assert.equal(p?.title, 'Follow-Up at 1, 3, 6 and 12 Months');
});

test('drafts without planner provenance are left alone', () => {
  assert.equal(plannerImageFor({ instagram: 'x' }), null);
  assert.equal(plannerImageFor(null), null);
  assert.equal(plannerImageFor(pack('My own template', 'x')), null);
});

test('scenes rotate, the prefix is stripped, unknown angles fall back to the pillar', () => {
  const p = plannerImageFor(pack('Nutrition', '[Autopilot] The role of protein in recovery'))!;
  assert.equal(p.subject, 'The role of protein in recovery');
  assert.notEqual(plannerPromptLines(p, 0)[1], plannerPromptLines(p, 1)[1]);
  assert.equal(cleanTopic('[Autopilot] Sleep'), 'Sleep');
  assert.equal(titleFor('something new', 'Nutrition'), 'The Importance of Nutrition');
});

test('a brief written from the post replaces the fixed scene and the on-topic cue', () => {
  const base = plannerImageFor(pack('Nutrition', 'Hydration and cellular health'))!;
  const p = { ...base, dynamic: { scene: 'The physician pours a glass of water from a carafe with cucumber slices for the patient.', props: ['glass carafe of water', 'cucumber slices'], mustShow: 'water being poured' } };
  const lines = plannerPromptLines(p, 0).join(' ');
  assert.match(lines, /pours a glass of water/);
  assert.match(lines, /In clear view: glass carafe of water, cucumber slices/);
  assert.match(lines, /must clearly show water being poured/);
  assert.match(lines, /post titled "Hydration and Cellular Health"/);
  assert.doesNotMatch(lines, /oranges/);
  assert.match(onTopicCheck(p), /water being poured/);
});

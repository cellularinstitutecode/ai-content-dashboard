import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILLARS } from './content-strategy.ts';
import { BLOG_ANGLES } from './strategy-seed.ts';
import { FAMILY_ORDER, PILLAR_SCENES, SHOTS, SHOT_COUNT, TITLES, cleanTopic, plannerImageFor, plannerPromptLines, onTopicCheck, shotFor, titleFor } from './planner-image.ts';

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

test('a planner draft is pictured in one of the shots, with its objects, craft and title', () => {
  const p = plannerImageFor(pack('Nutrition', 'The role of protein in recovery'));
  assert.ok(p);
  assert.equal(p!.pillarId, 'nutrition');
  assert.equal(p!.size, '1024x1536');
  assert.equal(p!.title, 'Protein and Recovery');
  const lines = plannerPromptLines(p!, 0).join(' ');
  assert.match(lines, /^Subject: a photograph for an educational post titled "Protein and Recovery"/);
  assert.match(lines, /SHOT: /);
  assert.match(lines, /oranges/);
  assert.match(lines, /TITLE SPACE: the upper third/);
  assert.match(lines, /CRAFT: /);
  assert.doesNotMatch(lines, /black scrubs/);
  assert.match(onTopicCheck(p!), /onTopic/);
  const cancun = plannerPromptLines(plannerImageFor(pack('Cancun and health tourism', 'Recovering in a calm, warm environment'))!, 0).join(' ');
  assert.match(cancun, /turquoise Caribbean sea|Cancún/);
});

test('different posts get different shots, and a reroll moves to the next one', () => {
  const a = plannerImageFor(pack('Nutrition', 'The role of protein in recovery'))!;
  const b = plannerImageFor(pack('Sleep', 'What happens in the body while we sleep'))!;
  const shotOf = (lines: string[]) => lines.find((l) => l.startsWith('SHOT:'));
  assert.notEqual(shotOf(plannerPromptLines(a, 0)), shotOf(plannerPromptLines(b, 0)));
  assert.notEqual(shotOf(plannerPromptLines(a, 0)), shotOf(plannerPromptLines(a, 1)));
  assert.equal(SHOT_COUNT, SHOTS.length);
  assert.ok(SHOTS.some((s) => !s.people), 'at least one shot has no people in it at all');
});

test('a team direction replaces the scene but keeps the title space and the look', () => {
  const p = plannerImageFor(pack('Sleep', 'Simple habits that may improve sleep quality'))!;
  const lines = plannerPromptLines(p, 0, 'a couple at the table').join(' ');
  assert.match(lines, /Direction from the team.*a couple at the table/);
  assert.match(lines, /TITLE SPACE/);
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
  assert.match(lines, /pours a glass of water|glass carafe of water/);
  assert.match(lines, /cucumber slices/);
  assert.match(lines, /must clearly show water being poured/);
  assert.match(lines, /post titled "Hydration and Cellular Health"/);
  assert.doesNotMatch(lines, /oranges/);
  assert.match(onTopicCheck(p), /water being poured/);
});

test('the first three takes come from three different shot families', () => {
  // Three options that all read as "two people at a table" are not three
  // options. Step 0, 1 and 2 must be a people shot, an objects-only shot and a
  // close detail — whatever the post is.
  for (const seed of [0, 7, 31, 4096, 99999]) {
    const three = [0, 1, 2].map((i) => shotFor(seed, i));
    assert.deepEqual(three.map((s) => s.family), FAMILY_ORDER, `seed ${seed}`);
    assert.equal(new Set(three.map((s) => s.id)).size, 3, `seed ${seed}`);
  }
});

test('a fourth take repeats the family but never the same shot', () => {
  for (const seed of [0, 5, 77, 1234]) {
    for (let i = 0; i < FAMILY_ORDER.length; i += 1) {
      assert.notEqual(shotFor(seed, i).id, shotFor(seed, i + FAMILY_ORDER.length).id, `seed ${seed} step ${i}`);
    }
  }
});

test('every family has at least two shots, so a repeat is always a new picture', () => {
  for (const family of FAMILY_ORDER) {
    assert.ok(SHOTS.filter((s) => s.family === family).length >= 2, family);
  }
  assert.equal(SHOT_COUNT, SHOTS.length);
});

test('teaching props are a blocking defect and are banned from the craft notes', () => {
  const p = plannerImageFor(pack('Sleep', 'What happens in the body while we sleep'))!;
  const lines = plannerPromptLines(p, 0).join(' ');
  assert.match(lines, /no anatomical models/i);
  assert.match(lines, /skeletons|mannequins/i);
  assert.match(onTopicCheck(p), /anatomical model|teaching prop/i);
});

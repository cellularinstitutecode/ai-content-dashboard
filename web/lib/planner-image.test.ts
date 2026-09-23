import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILLARS } from './content-strategy.ts';
import { BLOG_ANGLES } from './strategy-seed.ts';
import { PILLAR_SCENES, PLAN_LENGTH, SHOTS, SHOT_COUNT, TITLES, cleanTopic, familyAt, plannerImageFor, plannerPromptLines, onTopicCheck, scienceAllowed, shotFor, titleFor } from './planner-image.ts';

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

test('teaching props are a blocking defect and are banned from the craft notes', () => {
  const p = plannerImageFor(pack('Sleep', 'What happens in the body while we sleep'))!;
  const lines = plannerPromptLines(p, 0).join(' ');
  assert.match(lines, /no anatomical models/i);
  assert.match(lines, /skeletons|mannequins/i);
  assert.match(onTopicCheck(p), /anatomical model|teaching prop/i);
});

test('slot 0 is always a consultation, whatever the pillar', () => {
  for (const id of ['nutrition', 'movement', 'recovery', 'sleep', 'diagnosis', 'unknown-pillar']) {
    assert.equal(familyAt({ pillarId: id, science: true }, 0), 'consult', id);
  }
});

test('the science slot is offered only when the post talks about biology', () => {
  // Any pillar can earn it — a sleep post about tissue repair is biology too.
  for (const id of ['recovery', 'sleep', 'nutrition', 'movement']) {
    assert.equal(familyAt({ pillarId: id, science: true }, 2), 'science', id);
    assert.notEqual(familyAt({ pillarId: id, science: false }, 2), 'science', id);
  }
  const p = { pillarId: 'recovery' as const, science: true };
  const offered = [0, 1, 2, 3].map((i) => familyAt(p, i));
  assert.ok(offered.includes('science'), offered.join(','));
  // Same pillar, a post that never mentions biology: the science slot becomes a still life.
  const q = { pillarId: 'recovery', science: false };
  const fallback = [0, 1, 2, 3].map((i) => familyAt(q, i));
  assert.ok(!fallback.includes('science'), fallback.join(','));
  // Only the science slot changes; the rest of the run is identical.
  assert.deepEqual(fallback.filter((_, i) => offered[i] !== 'science'), offered.filter((f) => f !== 'science'));
});

test('the living pillars lead with the outcome, the everyday pillars with the objects', () => {
  assert.equal(familyAt({ pillarId: 'movement', science: false }, 1), 'active');
  assert.equal(familyAt({ pillarId: 'active-living', science: false }, 1), 'active');
  assert.equal(familyAt({ pillarId: 'nutrition', science: false }, 1), 'still');
  assert.equal(familyAt({ pillarId: 'sleep', science: false }, 1), 'still');
  assert.equal(familyAt({ pillarId: 'diagnosis', science: false }, 1), 'still');
});

test('a walking post never unlocks a microscope, a recovery post does', () => {
  assert.equal(scienceAllowed('A ten-minute walk after dinner helps you wind down for the evening.'), false);
  assert.equal(scienceAllowed('Sleep is when tissue repair happens and inflammation settles.'), true);
  assert.equal(scienceAllowed('Mesenchymal stem cells release exosomes that signal to neighbouring cells.'), true);
});

test('every family has at least two shots, so a repeat is always a new picture', () => {
  for (const family of ['consult', 'science', 'active', 'still'] as const) {
    assert.ok(SHOTS.filter((s) => s.family === family).length >= 2, family);
  }
  assert.equal(SHOT_COUNT, SHOTS.length);
});

test('within a family a later take is a different shot', () => {
  for (const seed of [0, 5, 77, 1234]) {
    assert.notEqual(shotFor(seed, 0, 'consult').id, shotFor(seed, 1, 'consult').id, `seed ${seed}`);
    assert.notEqual(shotFor(seed, 0, 'science').id, shotFor(seed, 1, 'science').id, `seed ${seed}`);
  }
});

test('the science frame is checked as a real laboratory photograph, not for the post\'s objects', () => {
  const base = plannerImageFor(pack('Recovery', 'How tissue repairs itself after training'))!;
  const p = { ...base, science: true, shotFamily: 'science' as const };
  const check = onTopicCheck(p);
  assert.match(check, /real laboratory photograph|microscope field/i);
  assert.match(check, /rendered or illustrated cells|glowing/i);
  assert.doesNotMatch(check, /must clearly show/);
});

test('the active frame must be life outdoors, never a clinic', () => {
  const base = plannerImageFor(pack('Movement', 'Why staying active matters at every age'))!;
  const check = onTopicCheck({ ...base, shotFamily: 'active' });
  assert.match(check, /outdoors in daylight/i);
  assert.match(check, /any clinical room, equipment, uniform or procedure/i);
});

test('science and active frames do not inherit the post\'s objects', () => {
  const base = plannerImageFor(pack('Recovery', 'How tissue repairs itself after training'))!;
  const p = { ...base, science: true, dynamic: { quote: 'Repair happens overnight.', scene: 'The physician sets a glass of water down as she explains recovery.', props: ['a glass of water', 'a folded towel'], mustShow: 'a glass of water' } };
  const science = [0, 1, 2, 3].find((i) => familyAt(p, i) === 'science')!;
  const lines = plannerPromptLines(p, science).join(' ');
  assert.match(lines, /do not add the objects the post names/i);
  assert.doesNotMatch(lines, /a folded towel/);
  // The consult slot still does carry them.
  const consult = plannerPromptLines(p, 0).join(' ');
  assert.match(consult, /a folded towel|glass of water/);
});

test('renders are banned in the craft notes', () => {
  const p = plannerImageFor(pack('Nutrition', 'The role of protein in recovery'))!;
  const lines = plannerPromptLines(p, 0).join(' ');
  assert.match(lines, /No 3D renders/i);
  assert.match(lines, /no lens flare/i);
});

test('two of every four takes are the consultation', () => {
  for (const id of ['nutrition', 'movement', 'recovery', 'sleep']) {
    const four = [0, 1, 2, 3].map((i) => familyAt({ pillarId: id, science: true }, i));
    assert.equal(four.filter((f) => f === 'consult').length, 2, `${id}: ${four.join(',')}`);
    assert.equal(four.filter((f) => f === 'science').length, 1, `${id}: ${four.join(',')}`);
  }
});

test('the plan wraps, so a much-rerolled draft still reaches every slot', () => {
  // The bug this guards: options advance the draft's running variant, and a
  // draft rerolled a dozen times walked off the end of its own plan — no
  // outcome shot, no science slot, just consultations and still lifes.
  const p = { pillarId: 'movement', science: true };
  for (let step = 0; step < 24; step += 1) {
    assert.equal(familyAt(p, step), familyAt(p, step % PLAN_LENGTH), `step ${step}`);
  }
  assert.equal(familyAt(p, 4), 'consult');
  assert.equal(familyAt(p, 5), 'active');
  assert.equal(familyAt(p, 6), 'science');
  assert.equal(familyAt(p, 13), familyAt(p, 1));
});

test('slots 1 to 3 always cover the pillar shot, the science slot and the room', () => {
  for (const id of ['movement', 'sleep', 'nutrition', 'recovery', 'diagnosis']) {
    const three = [1, 2, 3].map((i) => familyAt({ pillarId: id, science: true }, i));
    assert.equal(three[1], 'science', id);
    assert.equal(three[2], 'consult', id);
    assert.notEqual(three[0], 'consult', id);
  }
});

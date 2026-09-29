// A clip rides on a strategy or pillar-rotation post only when it is about the
// same thing; otherwise the post keeps its hero image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachableClip, clipRelevant, topicWords, usesPillarRotation } from './clip-relevance.ts';

const SLOT = { mode: 'fixed_topic', seeded: 'weekly-strategy', pillarId: 'sleep-stress' };
const SLEEP = { pillar: 'Sleep and stress management', seedTopic: 'Sleep and stress management', query: 'How a regular bedtime helps your sleep and nutrition' };

test('an infusion guide is not a sleep post', () => {
  assert.equal(clipRelevant({ title: 'Infusion Administration Guide', description: 'What to expect at your IV session' }, SLEEP), false);
});

test('a clip about the pillar and the angle is', () => {
  assert.equal(clipRelevant({ title: 'Sleep hygiene: a regular bedtime routine' }, SLEEP), true);
  assert.equal(clipRelevant({ title: 'Better sleep', hashtags: '#bedtime #rest' }, SLEEP), true);
});

test('one shared generic or pillar-only word is not enough', () => {
  assert.equal(clipRelevant({ title: 'What to know about your time here' }, SLEEP), false);
  assert.equal(clipRelevant({ title: 'Sleep' }, SLEEP), false, 'two topic words, one of them the pillar');
  assert.equal(clipRelevant({ title: 'Bedtime nutrition snacks' }, SLEEP), false, 'the angle alone does not make it the pillar');
});

test('generic words and accents are dropped from the comparison', () => {
  assert.deepEqual(topicWords('Guía: what is the best time for Nutrición?'), ['guia', 'nutricion']);
});

test('strategy slots and pillar rotations are gated; other templates are not', () => {
  assert.equal(usesPillarRotation(SLOT), true);
  assert.equal(usesPillarRotation({ mode: 'pillars', pillars: ['Sleep', 'Nutrition'] }), true);
  assert.equal(usesPillarRotation({ mode: 'pillars', pillars: [] }), false);
  assert.equal(usesPillarRotation({ mode: 'fixed_topic', topic: 'stem cells' }), false);
  assert.equal(usesPillarRotation(null), false);
});

test('approve attaches a relevant clip on a pillar rotation, and the hero image otherwise', () => {
  const infusion = { url: 'https://x.test/infusion.mp4', title: 'Infusion Administration Guide' };
  const sleep = { url: 'https://x.test/sleep.mp4', title: 'Sleep hygiene and a regular bedtime' };
  const angle = { query: SLEEP.query, seedTopic: 'Sleep' };
  const ROTATION = { mode: 'pillars', pillars: ['Sleep and stress management', 'Nutrition'] };
  assert.equal(attachableClip({ ...angle, media: infusion }, ROTATION, 'Sleep and stress management'), null);
  assert.deepEqual(attachableClip({ ...angle, media: sleep }, ROTATION, 'Sleep and stress management'), sleep);
  assert.deepEqual(attachableClip({ ...angle, media: { ...infusion, relevant: true } }, ROTATION, 'x'), { ...infusion, relevant: true },
    'a clip the matcher already judged on its full text is trusted');
  // Outside the rotation, unchanged.
  assert.deepEqual(attachableClip({ ...angle, media: infusion }, { mode: 'fixed_topic', topic: 'IV therapy' }, 'IV'), infusion);
  assert.equal(attachableClip({ ...angle, media: null }, ROTATION, 'x'), null);
});

test('a weekly-strategy post never carries a clip, however relevant: it is text with a single image', () => {
  const sleep = { url: 'https://x.test/sleep.mp4', title: 'Sleep hygiene and a regular bedtime' };
  const angle = { query: SLEEP.query, seedTopic: 'Sleep' };
  assert.equal(attachableClip({ ...angle, media: sleep }, SLOT, 'Sleep and stress management'), null);
  assert.equal(attachableClip({ ...angle, media: { ...sleep, relevant: true } }, SLOT, 'x'), null);
});

test('wiring: stepDraft does not look for a clip for a strategy slot, built-in or dropped', () => {
  const src = readFileSync(new URL('../lib/autopilot.ts', import.meta.url), 'utf8');
  // usesStrategyVoice: the built-in weekly strategy's slots AND every slot from
  // a dropped strategy document (lib/strategy-voice.ts).
  assert.match(src, /const media = usesStrategyVoice\(strategy\) \? null : await findMatchingClip\(run\.user_id, angle, topic\);/);
});

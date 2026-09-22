import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStrategySlot, pillarForName, strategyBrand, strategyTopicPrompt, promotionFlags, SOFT_CTA_RE } from './strategy-voice.ts';

test('only seeded slots use the strategy voice', () => {
  assert.equal(isStrategySlot({ seeded: 'weekly-strategy' }), true);
  assert.equal(isStrategySlot({}), false);
  assert.equal(isStrategySlot(null), false);
});

test('template names map back to their pillar', () => {
  assert.equal(pillarForName('Sleep')?.id, 'sleep');
  assert.equal(pillarForName('  cancun and HEALTH tourism ')?.id, 'cancun');
  assert.equal(pillarForName('Weekly article'), null);
});

test('the strategy brand drops the promotional guidelines but keeps name, voice, aviso and visual', () => {
  const b = strategyBrand({ name: 'CI', voice: 'warm', guidelines: 'Always include See if you are a candidate', keywords: ['stem cell'], aviso_publicidad: 'X1', visual: { a: 1 } });
  assert.equal(b.name, 'CI');
  assert.equal(b.voice, 'warm');
  assert.equal(b.aviso_publicidad, 'X1');
  assert.deepEqual(b.visual, { a: 1 });
  assert.deepEqual(b.keywords, []);
  assert.doesNotMatch(String(b.guidelines), /Always include See if/);
  assert.match(String(b.guidelines), /Educational/);
});

test('the brief names the pillar, the angle and the rule', () => {
  const p = strategyTopicPrompt({ angle: 'Why sleeping longer does not always mean resting better', pillarName: 'Sleep', rule: 'R1' });
  assert.match(p, /weekly "Sleep" post/);
  assert.match(p, /resting better/);
  assert.match(p, /STANDING RULE.*R1/);
});

test('promotional habits are caught; a therapy named by the angle is allowed', () => {
  const pitch = 'Sleep matters. See if you are a candidate for our drug-free stem cell therapy. Schedule your free consultation. #StemCellTherapy';
  const f = promotionFlags(pitch, 'sleep quality');
  for (const l of ['free-consultation pitch', 'candidate pitch', '"drug-free / surgery-free" selling point', 'treatment hashtag', 'therapy pitch']) assert.ok(f.includes(l), l);
  assert.equal(promotionFlags('Deep sleep supports repair. Save this for tonight.', 'sleep').length, 0);
  assert.ok(!promotionFlags('Exosomes are one option.', 'Technologies such as exosomes').includes('therapy pitch'));
});

test('a gentle next step counts as a call to action', () => {
  assert.match('Save this for your next trip.', SOFT_CTA_RE);
  assert.match('Talk it through with your physician.', SOFT_CTA_RE);
});

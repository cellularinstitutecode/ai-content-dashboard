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

test('recovery services may be introduced, never sold', () => {
  assert.ok(promotionFlags('Our red light therapy and PEMF packages speed healing.', 'recovery').includes('service promotion'));
  assert.ok(promotionFlags('Book your HBOT session in our recovery lounge today.', 'recovery').includes('service promotion'));
  assert.deepEqual(
    promotionFlags('Recovery may involve rest, hydration and, for some patients, technologies such as HBOT or red light therapy, chosen with the care team.', 'Technologies that may support the recovery experience'),
    [],
  );
  const around = 'HBOT raises oxygen. HBOT sessions last an hour. Many people ask about HBOT.';
  assert.ok(promotionFlags(around, 'recovery').includes('post built around one service'));
});

test('a sales close is flagged; a sleep schedule is not', () => {
  assert.ok(promotionFlags('Sleep matters. Book your visit today.', 'sleep').includes('booking call to action'));
  assert.ok(promotionFlags('Questions? Contact us or DM us.', 'sleep').includes('booking call to action'));
  assert.deepEqual(promotionFlags('Keep a steady sleep schedule, even on weekends.', 'sleep'), []);
  assert.deepEqual(promotionFlags('Talk it through with your physician.', 'sleep'), []);
});

test('invented patient testimonials are flagged', () => {
  assert.ok(promotionFlags('As one patient put it: "I slept like a baby."', 'sleep').includes('patient testimonial'));
  assert.ok(promotionFlags('Our patients often tell us the beach helps.', 'recovery').includes('patient testimonial'));
  assert.deepEqual(promotionFlags('One patient may need three sessions while another needs one.', 'personalization'), []);
});

test('Cancun is described by its advantages, never ranked above other places', () => {
  assert.ok(promotionFlags('Cancun is the best destination in Mexico for recovery.', 'cancun').includes('destination superiority claim'));
  assert.ok(promotionFlags('Unlike other destinations, Cancun has it all.', 'cancun').includes('destination superiority claim'));
  assert.deepEqual(promotionFlags('Cancun has direct flights from many US and Canadian cities and a warm climate.', 'cancun'), []);
  assert.deepEqual(promotionFlags('A short walk is better than nothing.', 'movement'), [], 'no destination in the sentence');
  assert.deepEqual(promotionFlags('Cancun is not better than every other destination; it offers specific advantages.', 'cancun'), []);
});

test('identical outcomes are flagged; "not everyone will" is the point', () => {
  assert.ok(promotionFlags('Everyone who follows this will feel ten years younger.', 'protocols').includes('outcome promise'));
  assert.ok(promotionFlags('This approach reverses aging.', 'protocols').includes('outcome promise'));
  assert.ok(promotionFlags('A 90% success rate.', 'protocols').includes('outcome promise'));
  assert.deepEqual(promotionFlags('Not everyone will respond the same way, which is why plans differ.', 'protocols'), []);
});

test('a seeded slot finds its pillar by key, even after a rename', async () => {
  const { pillarForStrategy } = await import('./strategy-voice.ts');
  assert.equal(pillarForStrategy({ pillarId: 'nutrition' }, 'Nutrition (Tuesday AM)')?.id, 'nutrition');
  assert.equal(pillarForStrategy({ slot: 'sun-2' }, 'Whatever')?.id, 'recovery-cancun');
  assert.equal(pillarForStrategy({}, 'Sleep')?.id, 'sleep', 'legacy rows fall back to the name');
  assert.equal(pillarForStrategy({ slot: 'mon-blog' }, 'Weekly article'), null);
});

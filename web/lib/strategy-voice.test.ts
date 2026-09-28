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

test('the supporting phrase is on the angle, never a procedure search', async () => {
  const { pickSupportingPhrase } = await import('./strategy-voice.ts');
  const angle = 'Simple habits that may improve sleep quality';
  assert.equal(pickSupportingPhrase(angle, 'Sleep', [
    { keyword: 'stem cell therapy cancun', intents: ['informational'] },
    { keyword: 'best sleep clinic near me', intents: ['commercial'] },
    { keyword: 'how to improve sleep quality naturally', intents: ['informational'] },
  ]), 'how to improve sleep quality naturally');
  assert.equal(pickSupportingPhrase(angle, 'Sleep', [{ keyword: 'stem cell therapy cancun', intents: [] }]), undefined, 'the domain keyword is gone');
  assert.equal(pickSupportingPhrase(angle, 'Sleep', [{ keyword: 'knee replacement recovery', intents: [] }]), undefined, 'off the subject');
  assert.equal(pickSupportingPhrase('Why supplementation should also be personalized', 'Supplementation', [{ keyword: 'personalized supplements', intents: ['informational'] }]), 'personalized supplements');
});

test('the brief carries the day theme, both pillars of a shared slot, and follow-up where it is woven in', () => {
  const p = strategyTopicPrompt({
    angle: 'Why effective care begins with a thorough evaluation',
    pillarName: 'Diagnosis and assessment',
    dayTheme: 'Understand before treating',
    integrated: ['Patient follow-up'],
  });
  assert.match(p, /day's theme is "Understand before treating"/);
  assert.match(p, /connect the angle to "Patient follow-up"/);
  const sun = strategyTopicPrompt({ angle: 'Nature, the beach, and a calmer pace', pillarName: 'Recovery in Cancun', alsoCovers: ['Recovery and restoration', 'Cancun and health tourism'] });
  assert.match(sun, /counts for both "Recovery and restoration" and "Cancun and health tourism"/);
});

test('"Balanced" is the document\'s own sentence', async () => {
  const { EDITORIAL_DIRECTION } = await import('./strategy-voice.ts');
  assert.match(EDITORIAL_DIRECTION, /Balanced: medical education supported by lifestyle, recovery, and destination content\./);
});

test('the brief names what related slots already cover this week', () => {
  const p = strategyTopicPrompt({ angle: 'Nutrition and inflammation', pillarName: 'Nutrition', coveredThisWeek: ['Snacks that support steady energy'] });
  assert.match(p, /Related posts this week cover: "Snacks that support steady energy"\. Build on them/);
});

test('superiority in softer words is still superiority, in a sentence about the destination', () => {
  assert.ok(promotionFlags('Cancun is an ideal destination for recovery.', 'cancun').includes('destination superiority claim'));
  assert.ok(promotionFlags('Cancun is a paradise and a world-class hub for care.', 'cancun').includes('destination superiority claim'));
  assert.deepEqual(promotionFlags('An ideal breakfast has protein in it.', 'nutrition'), [], 'not a sentence about the destination');
});

test('recovery services are never compared', () => {
  assert.ok(promotionFlags('Red light therapy is more effective than PEMF for recovery.', 'recovery').includes('service comparison'));
  assert.deepEqual(promotionFlags('Recovery may include HBOT, red light therapy or PEMF, chosen with your care team.', 'Technologies that may support the recovery experience'), []);
});

test('a universal prescription is the opposite of personalized', () => {
  assert.ok(promotionFlags('Everyone should take magnesium at night.', 'sleep').includes('universal prescription'));
  assert.ok(promotionFlags('This routine works for everyone.', 'movement').includes('universal prescription'));
  assert.deepEqual(promotionFlags('Everyone should talk to their physician before starting.', 'movement'), []);
  assert.deepEqual(promotionFlags('There is no one-size-fits-all plan.', 'protocols'), [], 'negated');
});

test('related posts are built on, and the follow-up example varies by week', () => {
  const a = strategyTopicPrompt({ angle: 'x', pillarName: 'Diagnosis and assessment', integrated: ['Patient follow-up'], coveredThisWeek: ['y'], variant: 0 });
  const b = strategyTopicPrompt({ angle: 'x', pillarName: 'Diagnosis and assessment', integrated: ['Patient follow-up'], variant: 1 });
  assert.match(a, /Build on them from a different point/);
  assert.notEqual(a.match(/for example, ([^.]+)/)?.[1], b.match(/for example, ([^.]+)/)?.[1]);
});

test('Phase 3: the dealt format, reader and closing reach the writer, and a returning angle is told its old opening', () => {
  const p = strategyTopicPrompt({
    angle: 'Sleep and recovery',
    pillarName: 'Sleep',
    formatBrief: 'Shape: myth vs fact — open with a common belief.',
    audienceBrief: 'a patient back home after treatment',
    closingBrief: 'Close with one short question back to the reader.',
    previousOpening: 'Eight hours is not the same as rest.',
  });
  assert.match(p, /Write it for a patient back home after treatment — speak to their situation, without assuming anything about their health\./);
  assert.match(p, /Shape: myth vs fact/);
  assert.match(p, /For this post: Close with one short question back to the reader\./);
  assert.match(p, /published before, opening with: "Eight hours is not the same as rest\."/);
  assert.match(p, /do not reuse that opening/);
  // The closing comes after the no-promotion rules, so it is the last word on how to end.
  assert.ok(p.indexOf('For this post:') > p.indexOf('Shape:'));
});

test('Phase 3: without a deal the prompt is unchanged', () => {
  const p = strategyTopicPrompt({ angle: 'Sleep and recovery', pillarName: 'Sleep' });
  assert.doesNotMatch(p, /Write it for|For this post:|published before/);
});

test('Phase 3: the new gentle closings count as a soft next step', () => {
  for (const s of ['What does your evening look like?', 'How do you wind down?', 'Try this tonight.', 'Try it this week.']) {
    assert.match(s, SOFT_CTA_RE, s);
  }
});

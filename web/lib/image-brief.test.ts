import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefSource, briefSystemPrompt, briefUserPrompt, parseSceneBrief } from './image-brief.ts';

test('the brief reads the article first, without hashtags, REF or AVISO', () => {
  const src = briefSource({
    instagram: 'caption',
    blog: '## Why Protein Matters\nProtein helps repair tissue. #Protein\nREF: Smith 2020\nAVISO DE PUBLICIDAD: 123',
  });
  assert.match(src, /Protein helps repair tissue/);
  assert.doesNotMatch(src, /#Protein|REF:|AVISO|##/);
  assert.equal(briefSource({ instagram: 'Only a caption' }), 'Only a caption');
  assert.equal(briefSource(null), '');
});

test('the prompts carry the house style, the rules and a composition that varies', () => {
  assert.match(briefSystemPrompt(), /The framing is decided elsewhere/);
  assert.match(briefSystemPrompt(), /Never: any text/);
  const a = briefUserPrompt({ title: 'Protein and Recovery', angle: 'The role of protein in recovery', pillarName: 'Nutrition', text: 'x', variant: 0 });
  const b = briefUserPrompt({ title: 'Protein and Recovery', angle: 'The role of protein in recovery', pillarName: 'Nutrition', text: 'x', variant: 1 });
  assert.match(a, /Post title: Protein and Recovery/);
  assert.notEqual(a, b);
});

test('a good answer parses; unsafe or empty answers fall back', () => {
  const ok = parseSceneBrief('```json\n{"scene":"The physician points to a plate of grilled salmon and eggs while the patient listens.","props":["grilled salmon","boiled eggs","lentils"],"mustShow":"protein-rich foods on the table"}\n```');
  assert.deepEqual(ok?.props, ['grilled salmon', 'boiled eggs', 'lentils']);
  assert.equal(ok?.mustShow, 'protein-rich foods on the table');
  assert.equal(parseSceneBrief('not json'), null);
  assert.equal(parseSceneBrief({ scene: 'short', props: ['x'], mustShow: 'y' }), null);
  assert.equal(parseSceneBrief({ scene: 'A nurse prepares a syringe beside the patient at the table.', props: ['syringe'], mustShow: 'syringe' }), null);
  const filtered = parseSceneBrief({ scene: 'The physician shows the patient a bowl of berries and a glass of water.', props: ['bowl of berries', 'labelled bottle'], mustShow: 'fresh berries' });
  assert.deepEqual(filtered?.props, ['bowl of berries']);
});

test('anatomical models and teaching props are stripped from the brief', () => {
  assert.equal(parseSceneBrief({ scene: 'The physician turns a plastic model brain toward the patient as she explains.', props: ['a model brain'], mustShow: 'a model of the brain' }), null);
  const partial = parseSceneBrief({
    quote: 'Deep sleep is when the body does most of its repair.',
    scene: 'The physician sets a cup of chamomile tea beside a folded sleep diary as she explains the night.',
    props: ['an anatomical model of the brain', 'a cup of chamomile tea', 'a folded linen throw'],
    mustShow: 'a cup of chamomile tea beside a sleep diary',
  });
  assert.ok(partial);
  assert.deepEqual(partial!.props, ['a cup of chamomile tea', 'a folded linen throw']);
});

test('the brief prompt forbids teaching props outright', () => {
  assert.match(briefSystemPrompt(), /anatomical model/i);
  assert.match(briefSystemPrompt(), /skeleton|mannequin/i);
});

test('a device described on a person is stripped from the brief', () => {
  assert.equal(parseSceneBrief({ scene: 'The physician fastens a blood-pressure cuff around the patient\'s arm as she explains.', props: ['a blood-pressure cuff'], mustShow: 'a blood pressure cuff on the arm' }), null);
  const kept = parseSceneBrief({
    quote: 'A yearly check catches what you cannot feel.',
    scene: 'The physician turns a blank notebook toward the patient as she explains what a check covers.',
    props: ['an IV cannula', 'a blank notebook', 'a glass of water'],
    mustShow: 'a blank notebook turned toward the patient',
  });
  assert.ok(kept);
  assert.deepEqual(kept!.props, ['a blank notebook', 'a glass of water']);
});

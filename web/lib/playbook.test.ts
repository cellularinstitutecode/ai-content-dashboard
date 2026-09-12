// The clinic's playbook is prose, and prose is the easiest thing in a codebase
// to edit badly: a tidy-up that shortens a paragraph can delete the sentence
// that keeps the assistant from publishing. These lock the parts that are not
// style. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBOOK } from './playbook.ts';
import { ANTI_REPEAT_DAYS, HORIZON_DAYS, MAX_ATTEMPTS, SCORE_THRESHOLD } from './planner-constants.ts';

test('the compliance rules are all present by name', () => {
  assert.match(PLAYBOOK, /AVISO/, 'the advertising notice');
  assert.match(PLAYBOOK, /\bREF\b/, 'the citation line');
  assert.match(PLAYBOOK, /COFEPRIS/, 'the permit the AVISO carries');
  assert.match(PLAYBOOK, /present but never leading/i, "the user's own keyword rule, in their words");
});

test('nothing publishes, and it says so in the imperative', () => {
  assert.match(PLAYBOOK, /Nothing publishes/i);
  assert.match(PLAYBOOK, /draft/i);
  assert.match(PLAYBOOK, /Approve/);
  // The specific sentence that stops a model reasoning its way to a publish
  // call: not "prefer drafts", but "there is no such button".
  assert.match(PLAYBOOK, /no path in this system from you to a live\s+post/i);
});

test('a fabricated citation is forbidden explicitly, not merely discouraged', () => {
  assert.match(PLAYBOOK, /Invent a REF citation/i);
  assert.match(PLAYBOOK, /never fabricated/i);
});

test('the video default is the three networks, and a link means already posted', () => {
  const defaults = PLAYBOOK.slice(PLAYBOOK.indexOf('Nothing ticked'), PLAYBOOK.indexOf('# THE PLANNER'));
  for (const n of ['YouTube', 'LinkedIn', 'TikTok']) {
    assert.ok(defaults.includes(n), n + ' must be in the default set');
  }
  assert.match(PLAYBOOK, /A \*\*link\*\* in a column means it is ALREADY posted/);
});

test('the caption goes in column E', () => {
  assert.match(PLAYBOOK, /column E/);
});

// The whole reason planner-constants.ts exists. If somebody tunes a number and
// the playbook still says the old one, the assistant confidently explains an
// engine that no longer behaves that way.
test('the planner numbers are the engine’s real numbers', () => {
  assert.match(PLAYBOOK, new RegExp('\\b' + HORIZON_DAYS + ' days ahead'));
  assert.match(PLAYBOOK, new RegExp('scoring under\\s+' + SCORE_THRESHOLD + '\\b'));
  assert.match(PLAYBOOK, new RegExp('last ' + ANTI_REPEAT_DAYS + ' days'));
  assert.match(PLAYBOOK, new RegExp('stops after ' + MAX_ATTEMPTS + ' attempts'));
});

test('multiple blogs a day is answered as several templates, not one', () => {
  const section = PLAYBOOK.slice(PLAYBOOK.indexOf('MORE THAN ONE BLOG PER DAY'));
  assert.ok(section.length > 200, 'the section must exist');
  assert.match(section, /several templates, not one/i);
  assert.match(section, /time_of_day/);
  assert.match(section, /pillars/);
  // It must push the assistant to ACT, not only explain — the thing the user
  // asked for was a planner it can set up, not a planner it can describe.
  assert.match(section, /create_schedule/);
});

test('the batch rule is ask-per-batch, which is what replaced "never queue"', () => {
  assert.match(PLAYBOOK, /Ask once for\s+the batch/i);
  assert.doesNotMatch(PLAYBOOK, /NEVER queue anything to Metricool/i);
});

test('it stays dense enough to prompt-cache without dominating the window', () => {
  // Not a style rule: this block is sent on every single turn. Two thousand
  // words of clinic background would cost more than the conversation.
  const words = PLAYBOOK.split(/\s+/).length;
  assert.ok(words > 600, 'too thin to be a brain: ' + words);
  assert.ok(words < 1600, 'too long to send every turn: ' + words);
});

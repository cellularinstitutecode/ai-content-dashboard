// web/lib/strategy-wiring.test.ts
//
// The three places the seeded week could be silently undone. None of them can
// be loaded by the test runner — a React component, a route that imports
// `server-only`, and the engine — so these are source checks on the lines that
// have to agree.
//
// Every one of these guards a failure that is INVISIBLE when it happens: a
// rule that vanishes on write, a rotation demoted by an edit that looked like
// it only changed the time, a second press that doubles the calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEED_MARK, isSeeded, seedRows } from './strategy-seed.ts';
import { normalizeStrategy } from './template-strategy.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a standing rule survives normalizeStrategy and reaches the writer', () => {
  // normalizeStrategy rebuilds the object from known keys and drops the rest,
  // and the seed route deliberately passes every row through it — so without
  // this line the two rules the clinic wrote down would vanish on write, with
  // nothing anywhere to show they had.
  const autopilot = src('lib/autopilot.ts');
  const strategy = src('lib/template-strategy.ts');
  assert.match(strategy, /rule\?: string;/, 'TemplateStrategy must carry it');
  assert.match(strategy, /rule: typeof s\.rule === 'string'/, 'normalizeStrategy must keep it');
  assert.match(strategy, /\.slice\(0, 400\)/, 'and clamp it, because it reaches the model as an instruction');
  // Exercised, not grepped: a rule survives the trip the route actually makes.
  assert.equal(normalizeStrategy({ mode: 'pillars', rule: '  keep me  ' }).rule, 'keep me');
  assert.match(
    autopilot,
    /STANDING RULE for this pillar \(must follow\): ' \+ strategy\.rule/,
    'topicPromptFor must hand it to the writer'
  );
  // And the rows that carry one still do.
  assert.equal(seedRows().filter((r) => r.strategy.rule).length, 2);
});

test('the planner no longer demotes a rotating slot to a fixed topic', () => {
  // The form writes mode: 'fixed_topic' and a name built from its theme box.
  // Run that over a slot loaded from the strategy and six weeks of angles
  // became one fixed topic — an EMPTY one, because the box was empty, because
  // the slot never had a theme to put in it.
  const planner = src('components/WeeklyPlanner.tsx');
  assert.match(planner, /rotating\?: \{ name: string; angles: number \}/, 'the draft must know what it is editing');
  assert.match(planner, /const rotating = Boolean\(draft\.rotating\)/);
  assert.match(planner, /mode: 'pillars',/, 'a rotating slot stays a rotation');
  assert.match(planner, /pillars: existing\?\.strategy\?\.pillars \|\| \[\]/, 'and keeps its bank');
  assert.match(planner, /rule: existing\?\.strategy\?\.rule/, 'and its standing rule');
  assert.match(planner, /name: rotating\s*\n?\s*\? \(existing\?\.name/, 'and its name');
  // The theme is not demanded of a slot that has no theme field.
  assert.match(planner, /if \(!draft\.rotating && !draft\.topic\.trim\(\)\)/);
});

test('the seed is one request, and it says what it will do before it does it', () => {
  const page = src('app/templates/page.tsx');
  assert.match(page, /'\/api\/templates\/strategy', \{ method: 'POST' \}/, 'one call, not fourteen');
  assert.match(page, /window\.confirm\(/, 'it asks first');
  assert.match(page, /Nothing is published by this/, 'and says the thing a person would worry about');
  assert.match(page, /Fifteen slots/, 'counted correctly — it said fourteen after the article was added');
  assert.match(page, /never touched/, 'and is honest about a name collision now that it is true');
  assert.match(page, /announce\('templates', 'autopilot'\)/, 'and the rest of the app hears about it');

  const planner = src('components/WeeklyPlanner.tsx');
  assert.match(planner, /Load the weekly strategy/);
  assert.match(planner, /onLoadStrategy\?: \(\) => Promise<void> \| void/, 'optional, so the component still stands alone');
});

test('the route reads what is already there before it writes, and fails closed', () => {
  // Writing without knowing what is there is exactly how fourteen becomes
  // twenty-eight — this table has no unique key to fall back on.
  const route = src('app/api/templates/strategy/route.ts');
  // `strategy` as well as the name: the mark inside it is the only thing that
  // makes a row safe to overwrite.
  assert.match(route, /\.from\('schedule_templates'\)\s*\n?\s*\.select\('id, name, strategy'\)/);
  assert.match(route, /if \(readError\)/);
  assert.match(route, /status: 503/, 'an unreadable account is refused, not guessed at');
  assert.match(route, /planSeed\(/, 'the decision itself lives in the tested module');
  assert.match(route, /normalizeStrategy\(row\.strategy\)/, 'and nothing reaches the column unnormalised');
  assert.match(route, /checkRateLimit\(auth\.userId, 'templates'\)/);
  assert.match(route, /requireAllowlistedUser\(\)/);
});

test('new rows are inserted and existing ones upserted, in separate calls', () => {
  // PostgREST takes the union of the keys in a batch and sends the missing
  // ones as NULL rather than letting the column default fill them. One mixed
  // batch would therefore insert the new templates with `id: null` and be
  // refused by the primary key — so a first press would fail entirely, and
  // only the second (all updates) would work.
  const route = src('app/api/templates/strategy/route.ts');
  assert.match(route, /\.insert\(strip\(fresh\)\)/, 'new rows must omit id, which only insert does');
  assert.match(route, /\.upsert\(strip\(existingRows\)\)/, 'and existing ones carry theirs');
  assert.match(route, /plan\.create\.map/);
  assert.match(route, /plan\.update\.map/);
  // And neither leg can run twice: a retry that re-ran the insert wrote
  // fifteen more templates on top of the fifteen just written.
  assert.match(route, /if \(fresh\.length && !inserted\)/);
  assert.match(route, /if \(existingRows\.length && !updated\)/);
});

test('a database without the migration is refused, not half-written', () => {
  // Rows written without their strategy are inert (mode defaults to 'off') AND
  // unmarked, so the next press cannot recognise them and creates fifteen
  // more. A calendar that does nothing and doubles on retry is worse than a
  // refusal that names the migration.
  const route = src('app/api/templates/strategy/route.ts');
  assert.match(route, /migration_missing/);
  assert.match(route, /autopilot\.sql/);
  assert.match(route, /Nothing was changed/);
  assert.doesNotMatch(route, /withoutStrategy/, 'the degrade path is gone');
});

test('the seed mark survives the engine\'s normaliser', () => {
  // The route passes every row through normalizeStrategy, which rebuilds the
  // object from known keys — so a mark it did not know about would vanish on
  // write and turn every re-seed into a duplicate.
  const strategy = src('lib/template-strategy.ts');
  assert.match(strategy, /seeded\?: string;/);
  assert.match(strategy, /seeded: typeof s\.seeded === 'string'/);
  // And the round trip the whole mark depends on, exercised rather than
  // grepped: what the route WRITES must still read back as ours.
  for (const row of seedRows()) {
    assert.equal(normalizeStrategy(row.strategy).seeded, SEED_MARK, row.name);
    assert.equal(isSeeded({ id: 'x', name: row.name, strategy: normalizeStrategy(row.strategy) }), true, row.name);
  }
});

test('an assistant edit keeps the mark and the standing rule', () => {
  // THE ONE A USER TRIGGERS BY ASKING. The assistant's update_schedule rebuilds
  // strategy from a fixed key list, and it did not carry `seeded` or `rule`.
  // "Make the Weekly article aim at traffic" therefore un-marked the row, and
  // the next press created a SECOND Monday article beside it — two articles and
  // six promo posts a week, from one plain-language edit.
  const assistant = src('app/api/assistant/route.ts');
  const build = assistant.slice(assistant.indexOf('strategy: {'));
  const obj = build.slice(0, build.indexOf('},'));
  assert.match(obj, /rule: current\.rule/, 'the standing rule must survive an edit');
  assert.match(obj, /seeded: current\.seeded/, 'and so must the mark');
});

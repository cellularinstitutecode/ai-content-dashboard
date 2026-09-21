// web/lib/weekly-pace.test.ts
//
// The backstop, and the thing it is a backstop against. Every test here is
// written from the failure it prevents rather than from the function's shape,
// because the function's shape is trivial and the failure is not: an engine
// that wakes hourly, approves its own work, and has a duplicated calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  weeklyPaceVerdict,
  weeklyCeiling,
  paceNote,
  counts,
  WEEKLY_CEILING,
  ROLLING_WINDOW_DAYS,
  PACE_SCAN_LIMIT,
} from './weekly-pace.ts';
import { DRAFTS_PER_WEEK } from './cadence.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const base = Date.parse('2026-03-02T09:00:00.000Z'); // a Monday
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * n posts spread evenly across `days` days from `from`, all going out.
 *
 * `days` defaults to six, NOT seven: the point of most of these is to put a
 * known number inside one rolling window, and a first draft of this helper that
 * put one post a day meant "thirty posts" was thirty DAYS of posts — about
 * seven in any week, which quietly passed the test for a doubled calendar.
 */
const spread = (n: number, days = 6, from = base) =>
  Array.from({ length: n }, (_, i) => ({
    publication_date: iso(from + Math.round((i * days * DAY) / Math.max(1, n))),
    status: 'approved',
    draft_id: 'draft-' + from + '-' + i,
  }));

/** One post fanned out to n networks: n rows, one draft — what the video sweep writes. */
const fannedOut = (draft: string, networks: number, when: number) =>
  Array.from({ length: networks }, (_, i) => ({
    id: draft + '-row-' + i,
    draft_id: draft,
    publication_date: iso(when),
    status: 'approved',
  }));

test('an ordinary week is nowhere near the ceiling', () => {
  // Fifteen slots plus a fortnight of reels is the real cadence. If a normal
  // week tripped this, the guard would be a nuisance rather than a backstop,
  // and somebody would raise it until it meant nothing.
  const v = weeklyPaceVerdict({ slot: iso(base + 3 * DAY), scheduled: spread(15) });
  assert.equal(v.ok, true);
  assert.ok(v.count <= WEEKLY_CEILING, v.count + ' of ' + v.ceiling);
});

test('a doubled calendar is refused', () => {
  // THE ONE THIS EXISTS FOR. schedule_templates has no unique key, the seed
  // route has already been found with two ways to write a second set of
  // fifteen, and everything upstream of here asks only whether ONE post is fit
  // to go. Thirty in a week passes all of it.
  const twice = spread(30);
  const v = weeklyPaceVerdict({ slot: iso(base + 2 * DAY), scheduled: twice });
  assert.equal(v.ok, false);
  assert.match(paceNote(v), /past the \d+ a week/);
  assert.match(paceNote(v), /approve it yourself/, 'a hold must say what a person can do about it');
  assert.match(paceNote(v), /duplicate templates/, 'and name the likeliest cause');
});

test('the window slides, so a weekend cannot be used to reset the count', () => {
  // A calendar-week ceiling is trivially defeated: fill Sunday, then fill
  // Monday, and no Monday-to-Sunday count ever sees more than one of them.
  // Every seven consecutive days is the only question worth asking.
  const sunday = base + 6 * DAY;
  const packed = [
    // A full ceiling's worth in the last hours of one calendar week...
    ...Array.from({ length: WEEKLY_CEILING }, (_, i) => ({
      publication_date: iso(sunday + i * 60 * 1000),
      status: 'approved',
    })),
    // ...and the same again in the first hours of the next.
    ...Array.from({ length: WEEKLY_CEILING }, (_, i) => ({
      publication_date: iso(sunday + DAY + i * 60 * 1000),
      status: 'approved',
    })),
  ];
  const v = weeklyPaceVerdict({ slot: iso(sunday + DAY + 60 * 60 * 1000), scheduled: packed });
  assert.equal(v.ok, false, 'two half-weeks back to back are still one week');
  assert.ok(v.count > WEEKLY_CEILING);
});

test('the worst window is found even when the slot sits at its end', () => {
  // The count must look BACKWARD as well as forward. A post dropped into the
  // last day of an already-full week is exactly the one to catch, and a
  // forward-only window would wave it through.
  const full = spread(WEEKLY_CEILING);
  const v = weeklyPaceVerdict({ slot: iso(base + 6 * DAY + 60 * 60 * 1000), scheduled: full });
  assert.equal(v.ok, false);
  assert.equal(v.count, WEEKLY_CEILING + 1);
});

test('posts more than a week either side are not counted', () => {
  const far = [
    ...spread(50, 6, base - 30 * DAY),
    ...spread(50, 6, base + 30 * DAY),
  ];
  const v = weeklyPaceVerdict({ slot: iso(base), scheduled: far });
  assert.equal(v.ok, true);
  assert.equal(v.count, 1, 'only the candidate itself is in the window');
});

test('the candidate is counted, so the ceiling is a ceiling and not one past it', () => {
  // Off by one here means the account publishes WEEKLY_CEILING + 1 a week
  // forever, which is the kind of quiet drift nobody ever notices.
  const slot = iso(base + 6 * DAY + 12 * 60 * 60 * 1000);
  const ok = weeklyPaceVerdict({ slot, scheduled: spread(WEEKLY_CEILING - 1) });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, WEEKLY_CEILING, 'exactly at the ceiling is allowed');

  const over = weeklyPaceVerdict({ slot, scheduled: spread(WEEKLY_CEILING) });
  assert.equal(over.ok, false, 'one past it is not');
});

test('a count is reported whether or not the post may go', () => {
  // A card that says "26 of 29" is worth more than one that says nothing until
  // the day it refuses.
  const v = weeklyPaceVerdict({ slot: iso(base), scheduled: spread(3) });
  assert.equal(v.ok, true);
  assert.equal(v.count, 4);
  assert.equal(v.ceiling, WEEKLY_CEILING);
  assert.equal(paceNote(v), '', 'nothing on the card when it may go');
});

test('rows that are not going out on their own are not counted', () => {
  // 'pending_review' is what a draft approval and the video sweep write. Those
  // wait for somebody, so counting them would hold real posts for the sake of
  // ones that may never publish.
  assert.equal(counts('approved'), true);
  assert.equal(counts('scheduled'), true);
  assert.equal(counts('SCHEDULED'), true, 'the column is not case-normalised anywhere else either');
  assert.equal(counts('pending_review'), false);
  assert.equal(counts('cancelled'), false);
  assert.equal(counts('canceled'), false, 'both spellings, because both have been written');
  // An unknown status COUNTS: not recognising a word is not evidence that a
  // post is inert, and this guard fails toward holding.
  assert.equal(counts('some_new_state'), true);
  assert.equal(counts(null), true);

  const waiting = spread(40).map((p) => ({ ...p, status: 'pending_review' }));
  assert.equal(weeklyPaceVerdict({ slot: iso(base), scheduled: waiting }).ok, true);
});

test('unreadable rows are skipped, not counted as zero-time', () => {
  // Date.parse('') is NaN. Treated as a number it becomes the epoch, which
  // would put forty imaginary posts in January 1970 — harmless here, and
  // exactly the sort of thing that is not harmless somewhere else.
  const junk = [
    { publication_date: '', status: 'approved' },
    { publication_date: 'not a date', status: 'approved' },
    { publication_date: null, status: 'approved' },
    null,
    undefined,
  ];
  const v = weeklyPaceVerdict({ slot: iso(base), scheduled: junk });
  assert.equal(v.ok, true);
  assert.equal(v.count, 1);
});

test('an unreadable slot holds rather than publishes', () => {
  // Fail closed, like every other decision the engine makes on its own.
  const v = weeklyPaceVerdict({ slot: 'whenever', scheduled: [] });
  assert.equal(v.ok, false);
  assert.match(paceNote(v), /no readable time/);
});

test('a calendar too big to count holds, and says so', () => {
  const v = weeklyPaceVerdict({ slot: iso(base), scheduled: spread(10), truncated: true });
  assert.equal(v.ok, false);
  assert.match(paceNote(v), new RegExp('more than ' + PACE_SCAN_LIMIT + ' posts'));
  assert.match(paceNote(v), /looking at the calendar/);
});

test('a post fanned out to three networks is ONE post', () => {
  // THE DEFECT THE AUDIT FOUND, an hour after this shipped. lib/video-publish.ts
  // writes a `posts` row PER NETWORK, and the default is three of them
  // (youtube, linkedin, tiktok). Counting rows made a fourteen-reel week
  // forty-two against a ceiling of twenty-nine — so with AUTOPILOT_AUTOSCHEDULE
  // on, EVERY engine post would have been held on a perfectly ordinary week,
  // with a message blaming a full calendar.
  //
  // lib/cadence.ts says in as many words that `posts` is the wrong unit because
  // it "counts one draft once per network". I read that line and then used the
  // number against `posts` anyway.
  const reels = Array.from({ length: 14 }, (_, i) =>
    fannedOut('reel-' + i, 3, base + Math.round((i * 6 * DAY) / 14)),
  ).flat();
  assert.equal(reels.length, 42, 'a worked week really is forty-two rows');

  const v = weeklyPaceVerdict({ slot: iso(base + 3 * DAY), scheduled: reels });
  assert.equal(v.ok, true, 'a normal week of reels must not hold anything');
  assert.equal(v.count, 15, 'fourteen reels and the candidate, not forty-three');
});

test('rows with no draft still count one each, and are never merged', () => {
  // Undercounting is the failure that matters here, so two unidentifiable rows
  // are two posts rather than one.
  const noDraft = [
    { publication_date: iso(base), status: 'approved' },
    { publication_date: iso(base + 60 * 1000), status: 'approved' },
    { id: 'r1', publication_date: iso(base + 2 * 60 * 1000), status: 'approved' },
    { id: 'r2', publication_date: iso(base + 3 * 60 * 1000), status: 'approved' },
  ];
  const v = weeklyPaceVerdict({ slot: iso(base + 4 * 60 * 1000), scheduled: noDraft });
  assert.equal(v.count, 5, 'four distinct rows plus the candidate');
});

test('the candidate is never collapsed into an existing row for its own draft', () => {
  // A posts row already existing for this run's draft means a double send,
  // which rescueStrandedApprovals owns. Merging them here would hide it, and
  // counting one extra errs toward holding.
  const same = fannedOut('same-draft', 3, base);
  const v = weeklyPaceVerdict({ slot: iso(base), scheduled: same });
  assert.equal(v.count, 2, 'the draft once, plus the candidate');
});

test('a fanned-out week still trips the ceiling when it genuinely should', () => {
  // The dedupe must not become a way to smuggle a doubled calendar past the
  // guard: thirty DISTINCT drafts is still thirty posts.
  const many = Array.from({ length: 30 }, (_, i) =>
    fannedOut('d-' + i, 3, base + Math.round((i * 6 * DAY) / 30)),
  ).flat();
  const v = weeklyPaceVerdict({ slot: iso(base + 2 * DAY), scheduled: many });
  assert.equal(v.ok, false);
  assert.ok(v.count > WEEKLY_CEILING, v.count + ' of ' + v.ceiling);
});

test('the ceiling is derived from the cadence, not typed beside it', () => {
  // The drift lib/cadence.ts exists to prevent: add a slot to the strategy and
  // this must widen with it, or the guard starts refusing the calendar it was
  // built for.
  assert.equal(WEEKLY_CEILING, DRAFTS_PER_WEEK);
  assert.equal(ROLLING_WINDOW_DAYS, 7);
});

test('AUTOPILOT_WEEKLY_CEILING is honoured, and nothing turns the ceiling off', () => {
  assert.equal(weeklyCeiling('40'), 40);
  assert.equal(weeklyCeiling(' 40 '), 40);
  assert.equal(weeklyCeiling('40.9'), 40, 'a fractional post is not a thing');
  // Everything that is not a usable number leaves the default in place. In
  // particular there is no value that removes the ceiling: somebody who wants
  // no limit can turn AUTOPILOT_AUTOSCHEDULE off and approve by hand, which is
  // the same amount of work and involves reading the posts.
  for (const raw of [undefined, null, '', '   ', 'lots', '0', '-5', 'Infinity', 'NaN']) {
    assert.equal(weeklyCeiling(raw), WEEKLY_CEILING, JSON.stringify(raw));
  }
  const v = weeklyPaceVerdict({ slot: iso(base), scheduled: spread(3), ceiling: 2 });
  assert.equal(v.ok, false, 'a lowered ceiling really does bind');
  assert.equal(v.ceiling, 2);
});

// --- where it is bolted on ---------------------------------------------------

test('the engine checks the week before it presses its own Approve', () => {
  // Source check: lib/autopilot.ts imports `server-only`. The ORDER is the
  // assertion — a pace check after the send would be a report, not a guard.
  const autopilot = src('lib/autopilot.ts');
  // Anchored on the comment rather than the call, because the call appears
  // twice — the second time in the guard for an unreadable slot, which sits
  // BEFORE the query and silently broke this slice when it was added.
  const check = autopilot.indexOf('THE WEEK, not the post');
  const approve = autopilot.indexOf("approveRun(run.id, run.user_id, { schedule: true })");
  assert.ok(check > 0, 'the pace check is gone');
  assert.ok(approve > check, 'the week must be counted BEFORE the post is sent');
  const block = autopilot.slice(check, approve);
  assert.match(block, /weeklyPaceVerdict\(\{/);
  // Scoped to the account, and looking both ways.
  assert.match(block, /\.eq\('user_id', run\.user_id\)/);
  assert.match(block, /\.gte\('publication_date'/);
  assert.match(block, /\.lte\('publication_date'/, 'a forward-only window misses a slot dropped into a full week');
  // An unreadable calendar must not read as an empty one...
  assert.match(autopilot, /autopilot:autoschedule-pace/);
  // ...and must not read as SILENCE either. autoSchedule is reached only at the
  // ready_for_review transition, and that state is not in ACTIVE_STATES, so no
  // later tick revisits the run: returning without a note demoted the post to
  // manual approval permanently, with a blank card.
  const paceFail = autopilot.slice(autopilot.indexOf('if (paceError) {'));
  const branch = paceFail.slice(0, paceFail.indexOf('const rows ='));
  assert.match(branch, /await hold\(/, 'a calendar that could not be read must say so on the card');
  assert.match(branch, /Nothing was sent/);

  // The row it counts must carry what identifies the POST, not just the time.
  assert.match(block, /\.select\('id, draft_id, publication_date, status'\)/);
  // And the statuses the module discards are dropped before they can spend the
  // scan budget — 500 pending_review rows would otherwise flip the guard into
  // its permanent truncated hold with nothing actually going out.
  assert.match(block, /\.not\('status', 'in',/);
});

test('only the engine is bound by it, never a person pressing Approve', () => {
  // The ceiling stands in for the reviewer who is not there. Refusing that
  // reviewer their own button would be a guard arguing with the thing it
  // substitutes for.
  const autopilot = src('lib/autopilot.ts');
  const inAutoSchedule = autopilot.slice(
    autopilot.indexOf('async function autoSchedule('),
    autopilot.indexOf('export async function advanceRuns('),
  );
  const inside = (inAutoSchedule.match(/weeklyPaceVerdict\(/g) || []).length;
  assert.ok(inside >= 1, 'it belongs inside autoSchedule');
  assert.equal(
    (autopilot.match(/weeklyPaceVerdict\(/g) || []).length,
    inside,
    'every call site must be inside autoSchedule; anywhere else and it is binding a human',
  );
  for (const file of ['app/api/posts/route.ts', 'app/api/templates/apply/route.ts']) {
    assert.doesNotMatch(src(file), /weeklyPaceVerdict/, file + ' must not gate a person on the pace');
  }
});

test('the setting is documented where somebody configuring it will read it', () => {
  const env = src('.env.example');
  assert.match(env, /AUTOPILOT_WEEKLY_CEILING/);
  assert.match(env, new RegExp(String(WEEKLY_CEILING)), 'the default belongs in the file, not in somebody’s memory');
});

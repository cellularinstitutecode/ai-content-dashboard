// web/lib/planner-slot.test.ts
//
// "I'm still missing my weekly planner."
//
// The planner has held a theme per day since it was built, and the only thing
// that could use it was the Autopilot — which writes its OWN post for that
// slot. A post already written could not be placed on a day at all: the panel
// offered "the next free slots" and a datetime box, and the planner sat on
// another page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextDayAt, parseTimeOfDay, themeLabel, weekFromThemes } from './planner-slot.ts';

test('a time of day is read, and an unreadable one is the planner’s own default', () => {
  assert.deepEqual(parseTimeOfDay('09:00'), { h: 9, m: 0 });
  assert.deepEqual(parseTimeOfDay('17:30'), { h: 17, m: 30 });
  assert.deepEqual(parseTimeOfDay('9:05 AM'), { h: 9, m: 5 });
  assert.deepEqual(parseTimeOfDay(''), { h: 9, m: 0 });
  assert.deepEqual(parseTimeOfDay('nonsense'), { h: 9, m: 0 });
  // Out of range is clamped rather than wrapped into another day.
  assert.deepEqual(parseTimeOfDay('99:99'), { h: 23, m: 59 });
});

test('picking a day gives the next time it comes round', () => {
  // Thursday 17 September 2026, 10:00.
  const now = new Date(2026, 8, 17, 10, 0, 0);
  assert.equal(now.getDay(), 4, 'the fixture really is a Thursday');
  assert.equal(nextDayAt(5, '09:00', now), '2026-09-18T09:00', 'Friday is tomorrow');
  assert.equal(nextDayAt(1, '09:00', now), '2026-09-21T09:00', 'Monday is next week');
});

test('today counts only while its slot is still ahead', () => {
  // THE CASE THAT WOULD HAVE BEEN REFUSED AT THE DOOR. Picking "Thursday" in
  // the afternoon must not schedule a post for that morning: a time in the past
  // is refused, and the person is left wondering what they did wrong.
  const morning = new Date(2026, 8, 17, 8, 0, 0);
  assert.equal(nextDayAt(4, '09:00', morning), '2026-09-17T09:00', 'still ahead today');

  const afternoon = new Date(2026, 8, 17, 16, 0, 0);
  assert.equal(nextDayAt(4, '09:00', afternoon), '2026-09-24T09:00', 'gone today, so next week');

  // Exactly on the minute counts as gone: a post scheduled for right now is a
  // race with the clock nobody asked to run.
  const onTheDot = new Date(2026, 8, 17, 9, 0, 0);
  assert.equal(nextDayAt(4, '09:00', onTheDot), '2026-09-24T09:00');
});

test('the week reads Monday first, the way the planner page shows it', () => {
  const themes = [
    { id: 'a', name: 'Monday post', days: [1], time: '09:00', networks: ['instagram'] },
    { id: 'b', name: 'diag-probe', days: [2], time: '09:00', networks: ['instagram'] },
    { id: 'c', name: 'Twice', days: [1, 5], time: '17:00', networks: ['linkedin'] },
  ];
  const week = weekFromThemes(themes);
  assert.deepEqual(week.map((d) => d.name), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.deepEqual(week[0].themes.map((t) => t.id), ['a', 'c'], 'a theme on two days appears on both');
  assert.deepEqual(week[4].themes.map((t) => t.id), ['c']);
  assert.deepEqual(week[2].themes, [], 'a day with no theme is still a day');
});

test('a day with no theme still offers a time', () => {
  assert.equal(themeLabel([]), 'No theme — 09:00');
  assert.equal(
    themeLabel([{ id: 'a', name: 'Monday post', days: [1], time: '09:00', networks: [] }]),
    'Monday post · 09:00',
  );
});

// --- THE PANEL USES IT ------------------------------------------------------

test('the schedule panel offers the planner, and the picture has three sources', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

  const panel = src('components/SchedulePack.tsx');
  assert.match(panel, /\/api\/templates/, 'the planner’s own themes, not a second list of days');
  assert.match(panel, /nextDayAt\(d\.day, time\)/, 'picking a day sets the next time it comes round');

  const picker = src('components/HeroImagePicker.tsx');
  assert.match(picker, /Our library/, 'a real photograph from the team’s Drive folder');
  assert.match(picker, /Drop a file/, 'or one from your desk');
  assert.match(picker, /Describe it/, 'or a generated one with a direction somebody wrote');
  assert.match(picker, /action: 'import_image'/, 'the library photo is copied so a network can fetch it');
  assert.match(picker, /canvas\.toDataURL\('image\/jpeg'/, 'a phone photograph is resized here, or the body is refused before it arrives');

  const route = src('app/api/drafts/image/route.ts');
  assert.match(route, /const direction = typeof body\?\.prompt === 'string'/, 'a written direction reaches generation');
  assert.match(route, /if \(useUrl \|\| dataUrl\)/, 'and a chosen photograph skips generation entirely');
});

test('a chosen photograph is not put through the no-text check', () => {
  const route = readFileSync(new URL('../app/api/drafts/image/route.ts', import.meta.url), 'utf8');
  const block = route.slice(route.indexOf('if (useUrl || dataUrl)'), route.indexOf('const existingHasText'));
  // The rule exists because an image MODEL writes gibberish signage. A real
  // photograph of the clinic has a sign on the wall, and refusing it would be
  // refusing the thing that was asked for.
  assert.ok(!/verif/i.test(block), 'a photograph the clinic chose is theirs');
  assert.match(block, /source/, 'but where it came from is recorded');
});

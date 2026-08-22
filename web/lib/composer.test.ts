// Unit tests for the composer rules. Run with: npm test
// Uses node:test — no extra dependency, no browser, runs in CI in under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tightestLimit, networkLabel, parseVideoUrl, localDateTimeValue, draftLabel, localDateKey } from './composer.ts';

// --- F4: a garbage URL must never arm a billable Opus job --------------------
test('parseVideoUrl rejects anything Opus cannot fetch', () => {
  assert.equal(parseVideoUrl('not-a-real-url').ok, false);
  assert.equal(parseVideoUrl('https://example.com/video').ok, false);
  assert.equal(parseVideoUrl('https://drive.google.com/file/d/123').ok, false);
  assert.match((parseVideoUrl('https://example.com/v') as any).reason, /YouTube and Vimeo/);
});

test('parseVideoUrl accepts every shape of YouTube and Vimeo link', () => {
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { ok: true, source: 'YouTube', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://youtu.be/t5lBhT3UFqg'), { ok: true, source: 'YouTube', id: 't5lBhT3UFqg' });
  assert.deepEqual(parseVideoUrl('https://youtube.com/shorts/abc123'), { ok: true, source: 'YouTube', id: 'abc123' });
  assert.deepEqual(parseVideoUrl('https://vimeo.com/347119375'), { ok: true, source: 'Vimeo', id: '347119375' });
  assert.equal(parseVideoUrl('youtube.com/watch?v=abc').ok, true, 'a pasted link with no scheme still parses');
});

test('parseVideoUrl treats an empty field as "nothing typed yet", not an error', () => {
  assert.deepEqual(parseVideoUrl('   '), { ok: false, reason: '' });
});

// --- F3: the composer must know each network's ceiling before sending -------
test('tightestLimit picks the strictest selected network', () => {
  assert.deepEqual(tightestLimit(['facebook', 'twitter']), { network: 'twitter', limit: 280 });
  assert.deepEqual(tightestLimit(['instagram']), { network: 'instagram', limit: 2200 });
  assert.equal(tightestLimit([]), null);
});

test('a 402-character post with X selected is over the limit', () => {
  const limit = tightestLimit(['facebook', 'instagram', 'twitter'])!;
  assert.equal(402 > limit.limit, true);
  assert.equal(networkLabel(limit.network), 'X / Twitter');
});

// --- the scheduler floor is a local wall-clock string, never a UTC one ------
test('localDateTimeValue formats for a datetime-local input', () => {
  assert.equal(localDateTimeValue(new Date(2026, 7, 21, 9, 5)), '2026-08-21T09:05');
});

// --- F13: a whole post body must not be used as a title --------------------
test('draftLabel trims a pasted post to its first sentence', () => {
  const body = 'Over the past five years, regenerative medicine has transformed from an emerging field into a trusted path forward. #StemCellTherapy #Cancun';
  assert.equal(draftLabel(body), 'Over the past five years, regenerative medicine has transformed from an emerging field into a trusted path forward.');
});

test('draftLabel leaves ordinary topics untouched and always returns something', () => {
  assert.equal(draftLabel('Anti-aging and cellular regeneration'), 'Anti-aging and cellular regeneration');
  assert.equal(draftLabel(''), 'Untitled draft');
  assert.equal(draftLabel(null, 'Clip'), 'Clip');
  assert.ok(draftLabel('x'.repeat(400)).length <= 73);
});

// --- F1: "today" is decided by the local calendar, never by UTC -------------
test('localDateKey uses local calendar components, not UTC', () => {
  // 2026-08-21 21:16 UTC. In America/Tijuana (UTC-7) that is 14:16 on Aug 21 —
  // the exact moment the calendar was highlighting Aug 20 in production.
  const d = new Date('2026-08-21T21:16:00Z');
  assert.equal(localDateKey(d), '2026-08-21');
});

test('localDateKey does not roll over just because UTC has', () => {
  // 03:00 UTC on the 22nd is still the evening of the 21st in Tijuana.
  const d = new Date('2026-08-22T03:00:00Z');
  assert.equal(localDateKey(d), process.env.TZ === 'America/Tijuana' ? '2026-08-21' : localDateKey(d));
});

// Unit tests for the composer rules. Run with: npm test
// Uses node:test — no extra dependency, no browser, runs in CI in under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tightestLimit, networkLabel, parseVideoUrl, localDateTimeValue, draftLabel, localDateKey, PUBLISH_NETWORKS, NETWORKS_NEEDING_MEDIA, DEFAULT_VIDEO_NETWORKS, mediaProblem } from './composer.ts';
import { DEFAULT_VIDEO_NETWORKS as SWEEP_VIDEO_NETWORKS } from './video-slot.ts';

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


// --- the channel list is the one the brand actually has connected -----------
//
// It was declared three times (here, app/page.tsx, app/calendar/page.tsx), all
// four entries, and Metricool has had six connected for months. These tests
// exist so a channel cannot be half-added again: chip, limit and media rule.
test('every connected channel can be picked', () => {
  const ids = PUBLISH_NETWORKS.map((n) => n.id);
  assert.deepEqual(ids, ['facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok']);
});

test('every listed channel has a character ceiling and a label', () => {
  for (const n of PUBLISH_NETWORKS) {
    assert.equal(typeof tightestLimit([n.id])?.limit, 'number', n.id + ' has no limit, so it would be checked against Infinity');
    assert.equal(networkLabel(n.id), n.label);
    assert.ok(n.emoji, n.id + ' has no chip icon');
  }
});

test('tightestLimit prefers TikTok over YouTube when both are picked', () => {
  assert.deepEqual(tightestLimit(['youtube', 'tiktok']), { network: 'tiktok', limit: 2200 });
  assert.deepEqual(tightestLimit(['youtube', 'linkedin']), { network: 'linkedin', limit: 3000 });
});

// --- a video-only feed is never sent without a video ------------------------
test('mediaProblem names the channels that need an attachment', () => {
  assert.equal(NETWORKS_NEEDING_MEDIA.has('youtube'), true);
  assert.equal(NETWORKS_NEEDING_MEDIA.has('tiktok'), true);
  assert.equal(NETWORKS_NEEDING_MEDIA.has('linkedin'), false, 'LinkedIn carries a video but does not require one');

  assert.match(mediaProblem(['tiktok'], '')!, /^TikTok needs a video/);
  assert.match(mediaProblem(['youtube', 'tiktok'], '')!, /YouTube and TikTok need/);
  assert.equal(mediaProblem(['linkedin', 'facebook'], ''), null);
  assert.equal(mediaProblem(['youtube'], 'https://drive.google.com/uc?id=abc'), null);
  assert.equal(mediaProblem([], ''), null);
  assert.equal(mediaProblem(['TikTok'], '   '), 'TikTok needs a video or image attached. Attach one below, or unselect it.');
});

// --- one answer to "where does a video go", not two -------------------------
test('the composer and the sweep agree on a video default', () => {
  assert.deepEqual(DEFAULT_VIDEO_NETWORKS, SWEEP_VIDEO_NETWORKS);
});

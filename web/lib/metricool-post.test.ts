// The two rules that decide whether a post can go out and whether it keeps
// its picture. Both used to be implicit: draft/autoPublish were hard-coded
// constants, and media was simply absent from the replace body — so a
// rescheduled post lost its image and nobody could tell from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeFlags, replacePostBody } from './metricool-post.ts';

const base = { text: 'Hello', providers: ['facebook' as const], publicationDate: '2026-09-09T14:00:00.000Z' };

test('review mode keeps a post out of the live queue', () => {
  assert.deepEqual(modeFlags('review'), { draft: true, autoPublish: false });
});

test('scheduled mode is the one and only way a post goes live', () => {
  assert.deepEqual(modeFlags('scheduled'), { draft: false, autoPublish: true });
});

test('a replace carries the media, or Metricool drops the picture', () => {
  // URL STRINGS. {url} objects are the shape Metricool ANSWERS with; sent as a
  // request they are accepted with a 200 and the file is dropped.
  const body = replacePostBody({ ...base, mode: 'review', media: ['https://x/img.jpg'] });
  assert.deepEqual(body.media, ['https://x/img.jpg']);
});

test('no media is sent as an empty list, never omitted', () => {
  const body = replacePostBody({ ...base, mode: 'review' });
  assert.deepEqual(body.media, []);
  assert.ok('media' in body);
});

test('approve flips exactly the two queue flags and nothing else', () => {
  const draft = replacePostBody({ ...base, mode: 'review' });
  const live = replacePostBody({ ...base, mode: 'scheduled' });
  assert.equal(draft.draft, true); assert.equal(draft.autoPublish, false);
  assert.equal(live.draft, false); assert.equal(live.autoPublish, true);
  const strip = (b: any) => { const { draft: _d, autoPublish: _a, ...rest } = b; return rest; };
  assert.deepEqual(strip(draft), strip(live));
});

test('the date is sent as clinic wall-clock with its zone', () => {
  const body = replacePostBody({ ...base, mode: 'scheduled' });
  assert.equal(body.publicationDate.dateTime, '2026-09-09T09:00:00');
  assert.equal(body.publicationDate.timezone, 'America/Cancun');
});

test('an empty replace is refused before it reaches Metricool', () => {
  assert.throws(() => replacePostBody({ ...base, text: '   ', mode: 'review' }), /text and at least one network/);
  assert.throws(() => replacePostBody({ ...base, providers: [], mode: 'review' }), /text and at least one network/);
});


// --- YouTube's fields must survive an approve --------------------------------
test('a replace keeps youtubeData for a YouTube post, and never invents it', () => {
  const yt = { title: 'A title', type: 'short', privacy: 'public', madeForKids: false };
  const kept = replacePostBody({ ...base, providers: ['youtube'], mode: 'scheduled', youtubeData: yt }) as any;
  assert.deepEqual(kept.youtubeData, yt, 'approving would otherwise wipe the title the draft was accepted with');

  const other = replacePostBody({ ...base, providers: ['facebook'], mode: 'scheduled', youtubeData: yt }) as any;
  assert.equal('youtubeData' in other, false, 'a Facebook post has no business carrying YouTube fields');

  const none = replacePostBody({ ...base, providers: ['youtube'], mode: 'scheduled' }) as any;
  assert.equal('youtubeData' in none, false);
});

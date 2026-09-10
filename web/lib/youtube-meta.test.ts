// Unit tests for the YouTube-only fields. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_TITLE_MAX, youtubeTitleFrom, youtubeTypeFor, youtubePrivacyFor, youtubeDataFor,
} from './youtube-meta.ts';

// --- the title Metricool refused to accept -----------------------------------
test('a title falls back to the first line of the post', () => {
  assert.equal(
    youtubeTitleFrom('', 'Why a Floating Bed Frame Is Part of Our Protocol\n\nAt Cellular Institute…'),
    'Why a Floating Bed Frame Is Part of Our Protocol',
  );
  assert.equal(youtubeTitleFrom('  ', '\n\n   \nFirst real line\nsecond'), 'First real line');
});

test('the row title wins over the body', () => {
  assert.equal(youtubeTitleFrom('Reel · Oxygen Circuit', 'Some other opening line'), 'Reel · Oxygen Circuit');
});

test('< and > are removed, not escaped — YouTube refuses both', () => {
  assert.equal(youtubeTitleFrom('Stem cells <b>explained</b>'), 'Stem cells bexplained/b');
  assert.equal(/[<>]/.test(youtubeTitleFrom('a > b < c')), false);
});

test('a long title is cut to a word boundary under the limit', () => {
  const long = 'Regenerative medicine in Cancun and everything you have ever wanted to know about exosome therapy today';
  const out = youtubeTitleFrom(long);
  assert.ok(out.length <= YOUTUBE_TITLE_MAX, out.length + ' chars');
  assert.equal(out.endsWith(' '), false);
  assert.ok(long.startsWith(out), 'the cut must be a prefix of the original');
});

test('a title with no words at all is null, not "Untitled"', () => {
  assert.equal(youtubeTitleFrom('', ''), '');
  assert.equal(youtubeDataFor({ title: '', body: '' }), null);
});

test('newlines and runs of spaces collapse — a title is one line', () => {
  assert.equal(youtubeTitleFrom('Two   words\nhere'), 'Two words here');
});

// --- long video vs Short -----------------------------------------------------
test('only an explicit format makes it a Short', () => {
  assert.equal(youtubeTypeFor('Vertical 9:16'), 'short');
  assert.equal(youtubeTypeFor('Reel'), 'short');
  assert.equal(youtubeTypeFor('SHORTS'), 'short');
  // Unrecognised or absent stays a plain video: YouTube rejects a Short over
  // three minutes and the sheet does not record duration.
  assert.equal(youtubeTypeFor('Horizontal 16:9'), 'video');
  assert.equal(youtubeTypeFor(''), 'video');
  assert.equal(youtubeTypeFor(null), 'video');
});

// --- visibility --------------------------------------------------------------
test('public by default, and the sheet wins when it says otherwise', () => {
  assert.equal(youtubePrivacyFor('', null), 'public');
  assert.equal(youtubePrivacyFor('https://youtu.be/abc', null), 'public', 'a published link is not a privacy instruction');
  assert.equal(youtubePrivacyFor('Unlisted', null), 'unlisted');
  assert.equal(youtubePrivacyFor('no listado', null), 'unlisted');
  assert.equal(youtubePrivacyFor('Privado', null), 'private');
});

test('a deployment can change the default, but not override the sheet', () => {
  assert.equal(youtubePrivacyFor('', 'unlisted'), 'unlisted');
  assert.equal(youtubePrivacyFor('Unlisted', 'public'), 'unlisted');
  assert.equal(youtubePrivacyFor('', 'nonsense'), 'public');
});

// --- the whole object --------------------------------------------------------
test('youtubeDataFor answers every field Metricool asked for', () => {
  const out = youtubeDataFor({
    title: 'Why a Floating Bed Frame Is Part of Our Regenerative Care Protocol',
    format: 'Vertical 9:16',
    sheetYoutube: 'Unlisted',
  })!;
  assert.equal(out.title, 'Why a Floating Bed Frame Is Part of Our Regenerative Care Protocol');
  assert.equal(out.type, 'short');
  assert.equal(out.privacy, 'unlisted');
  // A legal declaration, never a guess.
  assert.equal(out.madeForKids, false);
});

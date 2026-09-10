import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACK_KEYS, packKeyContract } from './pack-keys.ts';

/** Exactly the sentence that shipped before channels were considered. */
const BEFORE = 'You always return STRICT JSON with exactly the keys: instagram, facebook, linkedin, blog.';

test('every existing caller is left byte-for-byte alone', () => {
  // lib/autopilot.ts, the assistant and /api/generate all reach this without
  // narrowing anything. If this string moves, their output changes with it.
  assert.equal(packKeyContract(), BEFORE);
  assert.equal(packKeyContract([]), BEFORE);
  assert.equal(packKeyContract(PACK_KEYS), BEFORE, 'asking for all four is asking for nothing special');
  assert.equal(packKeyContract(['telepathy']), BEFORE, 'an unknown channel narrows nothing');
});

test('a video stops paying for the mini-article nobody reads', () => {
  const said = packKeyContract(['linkedin', 'instagram']);
  assert.match(said, /Only instagram and linkedin are used/);
  assert.match(said, /write those in full/);
  assert.match(said, /empty strings/);
  // The SHAPE is unchanged — parseJsonStrict reads all four and an empty one is
  // already valid, so narrowing the work must not narrow the contract.
  assert.match(said, /exactly the keys: instagram, facebook, linkedin, blog/);
});

test('the same channels in any order produce the same bytes', () => {
  // The system block is cached (cache_control in lib/ai.ts), and caching is a
  // prefix match — a caller listing its channels differently would silently
  // miss the cache on every request.
  assert.equal(packKeyContract(['linkedin', 'instagram']), packKeyContract(['instagram', 'linkedin']));
});

test('an unknown channel alongside real ones is ignored, not echoed', () => {
  assert.equal(packKeyContract(['instagram', 'myspace']), packKeyContract(['instagram']));
});

test('one channel reads as English, not as a template with a plural stuck in it', () => {
  // "Only instagram are used" is the kind of wrong that reads as noise inside an
  // instruction the model is being asked to follow exactly.
  const one = packKeyContract(['instagram']);
  assert.match(one, /Only instagram is used — write it in full/);
  assert.match(packKeyContract(['instagram', 'linkedin']), /are used — write those in full/);
});

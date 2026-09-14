import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORPHAN_FLOOR_MS,
  objectKeyFromUrl,
  orphanObjects,
  referencedKeys,
  supersededKeys,
  totalBytes,
} from './storage-prune.ts';

const BUCKET = 'content-images';
const base = 'https://abc.supabase.co/storage/v1/object/public/' + BUCKET + '/';
const url = (key: string) => base + key;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-14T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

// --- keys from URLs ----------------------------------------------------------

test('objectKeyFromUrl reads the key out of a public Storage URL', () => {
  assert.equal(objectKeyFromUrl(url('packs/1-abc-hero.jpg'), BUCKET), 'packs/1-abc-hero.jpg');
  // A cache-buster is not part of the name.
  assert.equal(objectKeyFromUrl(url('packs/1-abc-hero.jpg?v=2'), BUCKET), 'packs/1-abc-hero.jpg');
  // Percent-encoding is undone so it matches what Storage lists.
  assert.equal(objectKeyFromUrl(url('packs/a%20b.png'), BUCKET), 'packs/a b.png');
});

test('objectKeyFromUrl answers null for anything that is not this bucket', () => {
  assert.equal(objectKeyFromUrl('https://drive.google.com/file/d/xyz/view', BUCKET), null);
  assert.equal(objectKeyFromUrl(url('packs/x.jpg'), 'brand-assets'), null);
  assert.equal(objectKeyFromUrl('', BUCKET), null);
  assert.equal(objectKeyFromUrl(null, BUCKET), null);
  assert.equal(objectKeyFromUrl(url(''), BUCKET), null);
});

// --- what a pack references ---------------------------------------------------

test('an image referenced by _image is never an orphan', () => {
  const keys = referencedKeys([{ _image: { url: url('packs/hero.jpg') } }], BUCKET);
  assert.deepEqual([...keys], ['packs/hero.jpg']);
});

test('an image referenced by a card in _cards.slides is never an orphan', () => {
  const pack = { _cards: { slides: [{ url: url('packs/c1.png') }, { url: url('packs/c2.png') }] } };
  const keys = referencedKeys([pack], BUCKET);
  assert.deepEqual([...keys].sort(), ['packs/c1.png', 'packs/c2.png']);
});

test('the match is against the whole pack, not a list of known fields', () => {
  // A field nobody has written yet still protects its object. Over-matching
  // keeps a file a little longer; under-matching deletes a picture a post needs.
  const pack = { somethingNew: { nested: [url('packs/future.jpg')] } };
  assert.ok(referencedKeys([pack], BUCKET).has('packs/future.jpg'));
});

test('packs that are not objects, and URLs of other buckets, contribute nothing', () => {
  const keys = referencedKeys(
    [null, undefined, 'text', 42, { _image: { url: 'https://abc.supabase.co/storage/v1/object/public/brand-assets/fonts/x.otf' } }],
    BUCKET,
  );
  assert.equal(keys.size, 0);
});

test('a key with a space is matched after decoding', () => {
  const keys = referencedKeys([{ _image: { url: url('packs/a%20b.png') } }], BUCKET);
  assert.ok(keys.has('packs/a b.png'));
});

// --- what a rewrite left behind ------------------------------------------------

test('regenerating a hero image supersedes the old object', () => {
  const prev = { _image: { url: url('packs/old.jpg') } };
  const next = { _image: { url: url('packs/new.jpg') } };
  assert.deepEqual(supersededKeys(prev, next, BUCKET), ['packs/old.jpg']);
});

test('a hero that is also a card is NOT superseded while the card remains', () => {
  // setHero makes _image.url the same object as slides[0].url. Regenerating the
  // hero must not delete the card that is still on the draft.
  const shared = url('packs/card-1.png');
  const prev = { _image: { url: shared }, _cards: { slides: [{ url: shared }] } };
  const next = { _image: { url: url('packs/fresh.jpg') }, _cards: { slides: [{ url: shared }] } };
  assert.deepEqual(supersededKeys(prev, next, BUCKET), []);
});

test('re-rendering a carousel supersedes every previous card at once', () => {
  const prev = { _cards: { slides: [{ url: url('packs/a.png') }, { url: url('packs/b.png') }] } };
  const next = { _cards: { slides: [{ url: url('packs/c.png') }] } };
  assert.deepEqual(supersededKeys(prev, next, BUCKET), ['packs/a.png', 'packs/b.png']);
});

test('deleting a draft supersedes everything it referenced', () => {
  const prev = { _image: { url: url('packs/h.jpg') }, _cards: { slides: [{ url: url('packs/c.png') }] } };
  assert.deepEqual(supersededKeys(prev, null, BUCKET), ['packs/c.png', 'packs/h.jpg']);
});

// --- orphans ------------------------------------------------------------------

const keyOf = (o: { name: string }) => 'packs/' + o.name;

test('an unreferenced object older than the floor is an orphan', () => {
  const objects = [{ name: 'stale.jpg', createdAt: daysAgo(30), size: 10 }];
  const out = orphanObjects(objects, new Set(), keyOf, NOW);
  assert.deepEqual(out.map((o) => o.name), ['stale.jpg']);
});

test('a referenced object is never an orphan, however old', () => {
  const objects = [{ name: 'kept.jpg', createdAt: daysAgo(400), size: 10 }];
  const out = orphanObjects(objects, new Set(['packs/kept.jpg']), keyOf, NOW);
  assert.deepEqual(out, []);
});

test('an object newer than the floor is never an orphan', () => {
  // import_image returns a URL before anything persists it; a just-uploaded
  // object is legitimately unreferenced for a moment.
  const objects = [
    { name: 'fresh.jpg', createdAt: daysAgo(1), size: 10 },
    { name: 'edge.jpg', createdAt: new Date(NOW - ORPHAN_FLOOR_MS + 1000).toISOString(), size: 10 },
  ];
  assert.deepEqual(orphanObjects(objects, new Set(), keyOf, NOW), []);
});

test('an object with no usable timestamp is never an orphan', () => {
  // "Unknown age" must not be read as "old".
  const objects = [{ name: 'when.jpg', createdAt: null }, { name: 'bad.jpg', createdAt: 'yesterday-ish' }];
  assert.deepEqual(orphanObjects(objects, new Set(), keyOf, NOW), []);
});

test('the floor is seven days', () => {
  assert.equal(ORPHAN_FLOOR_MS, 7 * DAY);
});

test('totalBytes tolerates missing sizes', () => {
  assert.equal(totalBytes([{ name: 'a', size: 5 }, { name: 'b' }, { name: 'c', size: null }, { name: 'd', size: 7 }]), 12);
});

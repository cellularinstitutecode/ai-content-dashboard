import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightPost } from './post-preflight.ts';

const fromVideo = { kind: 'video', sourceUrl: 'https://drive.google.com/file/d/1jX1Ww2M18iH6-5eM4YLZR9HKa1-PbZFo/view' };
const soon = new Date('2026-09-20T13:00:00.000Z');
const now = new Date('2026-09-18T13:00:00.000Z');
const ok = { network: 'linkedin', text: 'A short compliant post.', pack: fromVideo, hasMedia: true, format: 'Vertical 9:16', publishAt: soon, now };

test('a correct post passes', () => {
  assert.deepEqual(preflightPost(ok), { ok: true });
});

test('copy written from a video does not go out without the video — on EVERY network', () => {
  // THE GAP THIS MODULE EXISTS FOR. The old defence only dropped the networks
  // that REQUIRE media, so LinkedIn, Facebook and X published transcript-written
  // copy with no video at all — and once posts stopped waiting for Approve,
  // nothing anywhere caught it.
  for (const network of ['linkedin', 'facebook', 'twitter', 'youtube', 'tiktok', 'instagram']) {
    const v = preflightPost({ ...ok, network, hasMedia: false });
    assert.equal(v.ok, false, network + ' must refuse');
    assert.equal(v.ok === false && v.reason, 'no_video', network);
    assert.match(v.ok === false ? v.message : '', /written from a video/, network);
  }
});

test('a post that was not written from a video is unaffected', () => {
  assert.deepEqual(preflightPost({ ...ok, pack: { kind: 'blog' }, hasMedia: false, network: 'linkedin' }), { ok: true });
  assert.deepEqual(preflightPost({ ...ok, pack: null, hasMedia: false, network: 'linkedin' }), { ok: true });
});

test('over-limit copy is refused per network, and never trimmed', () => {
  const long = 'x'.repeat(2500);
  const v = preflightPost({ ...ok, network: 'tiktok', text: long });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'too_long');
  // The reason it is not trimmed is the point, so the message has to say it.
  assert.match(v.ok === false ? v.message : '', /AVISO and REF lines are at the end/);
  // The same copy is fine where the limit is higher.
  assert.equal(preflightPost({ ...ok, network: 'linkedin', text: long }).ok, true);
});

test('one limit table — the composer and the sweep cannot disagree', () => {
  // Facebook read 5,000 in one table and 63,206 in the other, so the counter
  // under the box and the rule that refuses the post were an order of
  // magnitude apart depending on which door you came through.
  const fb = 'x'.repeat(10_000);
  assert.equal(preflightPost({ ...ok, network: 'facebook', text: fb }).ok, true, 'Facebook really does take this much');
});

test('a landscape video is refused on a vertical-only network', () => {
  const v = preflightPost({ ...ok, network: 'tiktok', format: 'Horizontal 16:9' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'wrong_aspect');
  // and is fine on the networks that take it
  assert.equal(preflightPost({ ...ok, network: 'linkedin', format: 'Horizontal 16:9' }).ok, true);
  // An unknown format never invents a rule.
  assert.equal(preflightPost({ ...ok, network: 'tiktok', format: '' }).ok, true);
});

test('a time that has already passed is refused', () => {
  const v = preflightPost({ ...ok, publishAt: new Date('2026-09-17T13:00:00.000Z') });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'past');
  assert.equal(preflightPost({ ...ok, publishAt: '' }).ok, true, 'no time given is not this rule’s business');
  assert.equal(preflightPost({ ...ok, publishAt: 'not a date' }).ok, false);
});

test('a text-only send to a network that needs media is refused', () => {
  // Distinct from the video rule: this one is about the NETWORK's requirement,
  // and applies to a hand-written post with no pack at all.
  const v = preflightPost({ ...ok, pack: null, network: 'tiktok', hasMedia: false });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'needs_media');
});

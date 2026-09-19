// web/lib/autoschedule.test.ts
//
// The floor that replaces a person. Every case here is one that used to reach
// Metricool unremarked because a human was the only thing looking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoScheduleVerdict, holdNote, type AutoScheduleInput } from './autoschedule.ts';

/** A post that passes everything — each test spoils exactly one thing. */
const GOOD: AutoScheduleInput = {
  citation: 'verified',
  score: 84,
  threshold: 70,
  safetyFlags: 0,
  networks: ['instagram', 'facebook', 'linkedin'],
  hasMedia: true,
  claimSupport: 'supported',
};

test('everything good goes', () => {
  assert.deepEqual(autoScheduleVerdict(GOOD), { ok: true });
  assert.equal(holdNote(autoScheduleVerdict(GOOD)), '');
});

test('a DOI that is merely DOI-SHAPED does not go', () => {
  // checkCompliance proves the REF line contains something shaped like a DOI.
  // Only Crossref proves a paper answered to it, and that verdict was stamped
  // on the pack and never read at the door.
  for (const citation of ['not_found', 'unavailable', 'no_doi', undefined, null, '', 'weird']) {
    const v = autoScheduleVerdict({ ...GOOD, citation: citation as string });
    assert.equal(v.ok, false, JSON.stringify(citation) + ' must not pass');
    assert.equal(v.ok === false && v.reason, 'citation');
  }
  // And each says something different, because "held" with no reason is the
  // thing this whole file exists to avoid.
  const notFound = autoScheduleVerdict({ ...GOOD, citation: 'not_found' });
  const unavailable = autoScheduleVerdict({ ...GOOD, citation: 'unavailable' });
  assert.match(holdNote(notFound), /Crossref has no record/);
  assert.match(holdNote(unavailable), /could not be checked/);
  assert.notEqual(holdNote(notFound), holdNote(unavailable));
});

test('an unreachable Crossref is "not known", never "fine"', () => {
  // The fail-OPEN direction everywhere else in this codebase. Here it is the
  // wrong direction, and this is the assertion that keeps it that way.
  assert.equal(autoScheduleVerdict({ ...GOOD, citation: 'unavailable' }).ok, false);
});

test('a citation the judge says does not support the copy does not go', () => {
  const v = autoScheduleVerdict({ ...GOOD, claimSupport: 'unsupported' });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'claim');
  assert.match(holdNote(v), /does not clearly support/);
});

test('but a judge that did not run is not evidence of a problem', () => {
  // 'unchecked' is the judge being unavailable, and the DOI above is already
  // verified. Holding on it would mean no post ever goes out without a second
  // model call succeeding.
  assert.equal(autoScheduleVerdict({ ...GOOD, claimSupport: 'unchecked' }).ok, true);
  assert.equal(autoScheduleVerdict({ ...GOOD, claimSupport: undefined }).ok, true);
  assert.equal(autoScheduleVerdict({ ...GOOD, claimSupport: 'swapped' }).ok, true);
});

test('a score below the threshold does not go, and an absent one does not either', () => {
  const low = autoScheduleVerdict({ ...GOOD, score: 69 });
  assert.equal(low.ok, false);
  assert.equal(low.ok === false && low.reason, 'score');
  assert.match(holdNote(low), /scored 69 out of 100, below the 70/);
  assert.equal(autoScheduleVerdict({ ...GOOD, score: 70 }).ok, true, 'the threshold itself passes');

  for (const score of [null, undefined, Number.NaN]) {
    const v = autoScheduleVerdict({ ...GOOD, score: score as number });
    assert.equal(v.ok, false, String(score) + ' must not pass');
    assert.match(holdNote(v), /never scored/);
  }
});

test('any safety flag at all holds it', () => {
  // A flag is the rubric saying a person should look at this. One is enough.
  const v = autoScheduleVerdict({ ...GOOD, safetyFlags: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'safety');
  assert.match(holdNote(v), /raised 1 flag\b/);
  assert.match(holdNote(autoScheduleVerdict({ ...GOOD, safetyFlags: 3 })), /raised 3 flags/);
});

test('Instagram with no picture does not go — it would be refused anyway', () => {
  const v = autoScheduleVerdict({ ...GOOD, hasMedia: false });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'media');
  assert.match(holdNote(v), /instagram/);
  // LinkedIn and Facebook carry a picture but do not require one.
  assert.equal(autoScheduleVerdict({ ...GOOD, networks: ['linkedin', 'facebook'], hasMedia: false }).ok, true);
  // And the rule is read from the composer's set, so TikTok counts too.
  assert.equal(autoScheduleVerdict({ ...GOOD, networks: ['tiktok'], hasMedia: false }).ok, false);
});

test('no channels means nowhere to send it', () => {
  for (const networks of [[], null, undefined, ['', '  ']]) {
    const v = autoScheduleVerdict({ ...GOOD, networks: networks as string[] });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, 'networks');
  }
});

test('the worst reason is the one reported', () => {
  // A post can fail several at once. The card has room for one line, and it
  // should be the line that matters most — an unverifiable citation before a
  // missing picture.
  const v = autoScheduleVerdict({ ...GOOD, citation: 'not_found', score: 10, hasMedia: false, safetyFlags: 4 });
  assert.equal(v.ok === false && v.reason, 'citation');
});

test('every refusal says what to do about it, in words a person reads', () => {
  const messages = [
    autoScheduleVerdict({ ...GOOD, citation: 'not_found' }),
    autoScheduleVerdict({ ...GOOD, claimSupport: 'unsupported' }),
    autoScheduleVerdict({ ...GOOD, score: 12 }),
    autoScheduleVerdict({ ...GOOD, safetyFlags: 2 }),
    autoScheduleVerdict({ ...GOOD, hasMedia: false }),
  ].map(holdNote);
  for (const m of messages) {
    assert.ok(m.length > 30, 'too terse to act on: ' + JSON.stringify(m));
    assert.match(m, /^Held for you because /, 'it should read as a hold, not an error');
    assert.doesNotMatch(m, /undefined|null|NaN|\[object/, 'no internals leaked into the card');
  }
  assert.equal(new Set(messages).size, messages.length, 'each reason reads differently');
});

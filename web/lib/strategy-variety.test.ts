import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOG_SLOT_KEY, WEEK, slotKey } from './content-strategy.ts';
import { dealtWeek } from './strategy-rotation.ts';
import {
  AUDIENCES,
  CLOSINGS,
  FORMATS,
  PILLAR_AUDIENCES,
  dealtVariety,
  varietyBriefs,
  varietyFor,
  varietyLabels,
} from './strategy-variety.ts';

const WEEKS = 120;
const SOCIAL = WEEK.map(slotKey).filter((k) => k !== BLOG_SLOT_KEY);

test('every social slot is dealt a known format, audience and closing; the article is not', () => {
  for (let w = 0; w < WEEKS; w++) {
    const d = dealtVariety(w);
    assert.equal(d[BLOG_SLOT_KEY], undefined);
    for (const key of SOCIAL) {
      const v = d[key];
      assert.ok(v, key + ' week ' + w);
      assert.ok(FORMATS[v.format] && AUDIENCES[v.audience] && CLOSINGS[v.closing]);
    }
  }
});

test('a slot never repeats last week\'s format or closing', () => {
  for (let w = 1; w < WEEKS; w++) {
    for (const key of SOCIAL) {
      const a = varietyFor(key, w - 1)!;
      const b = varietyFor(key, w)!;
      assert.notEqual(a.format, b.format, key + ' format, week ' + w);
      assert.notEqual(a.closing, b.closing, key + ' closing, week ' + w);
    }
  }
});

test('an angle that comes round again never returns in the same format or for the same reader', () => {
  for (const key of SOCIAL) {
    const last = new Map<string, { format: string; audience: string }>();
    for (let w = 0; w < WEEKS; w++) {
      const angle = dealtWeek(w)[key];
      const v = varietyFor(key, w)!;
      const before = last.get(angle);
      if (before) {
        assert.notEqual(v.format, before.format, key + ' "' + angle + '" format, week ' + w);
        assert.notEqual(v.audience, before.audience, key + ' "' + angle + '" audience, week ' + w);
      }
      last.set(angle, v);
    }
  }
});

test('formats are spread across the week — never more than three of one shape', () => {
  for (let w = 0; w < WEEKS; w++) {
    const count = new Map<string, number>();
    for (const v of Object.values(dealtVariety(w))) count.set(v.format, (count.get(v.format) || 0) + 1);
    assert.ok(Math.max(...count.values()) <= 3, 'week ' + w + ': ' + JSON.stringify([...count]));
    assert.ok(count.size >= 5, 'week ' + w + ' uses at least five shapes');
  }
});

test('audiences come from the pillar\'s own readers, and Cancun never closes with "ask your physician"', () => {
  for (let w = 0; w < WEEKS; w++) {
    for (const slot of WEEK) {
      const key = slotKey(slot);
      if (key === BLOG_SLOT_KEY) continue;
      const v = varietyFor(key, w)!;
      assert.ok((PILLAR_AUDIENCES[slot.pillarId] || ['general']).includes(v.audience), key + ' ' + v.audience);
      if (slot.pillarId === 'cancun') assert.notEqual(v.closing, 'ask-physician', key + ' week ' + w);
    }
  }
});

test('every bank pillar has an audience list', () => {
  for (const slot of WEEK) {
    if (slotKey(slot) === BLOG_SLOT_KEY) continue;
    assert.ok(PILLAR_AUDIENCES[slot.pillarId]?.length, slot.pillarId);
  }
});

test('the deal is deterministic and has nothing before the epoch', () => {
  const key = SOCIAL[0];
  assert.deepEqual(varietyFor(key, 7), varietyFor(key, 7));
  assert.equal(varietyFor(key, -1), null);
  assert.equal(varietyFor(null, 3), null);
  assert.equal(varietyFor(key, null), null);
  assert.equal(varietyFor('no-such-slot', 3), null);
});

test('briefs and labels', () => {
  const v = { format: 'checklist', audience: 'traveller', closing: 'share' } as const;
  const b = varietyBriefs(v)!;
  assert.match(b.format, /checklist/);
  assert.match(b.audience, /United States or Canada/);
  assert.match(b.closing, /share/);
  assert.deepEqual(varietyLabels(v), { format: 'Checklist', audience: 'Travelling in' });
  assert.equal(varietyLabels(null), null);
  assert.equal(varietyLabels({ format: 'carousel', audience: 'general' }), null, 'an unknown stored value shows nothing');
  assert.equal(varietyBriefs(null), null);
});

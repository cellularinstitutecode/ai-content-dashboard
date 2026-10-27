// The Semrush spend guard. Run with: npm test
//
// The rule under test used to be one line in lib/semrush.ts:
//
//   if (bal == null) return true;   // can't read balance → let the API decide
//
// Fail-open. And because an unreadable balance was cached for the full
// ten-minute TTL, a single HTML error page from the balance endpoint switched
// the protection on the clinic's paid unit pot off for ten minutes, while paid
// calls kept succeeding and nothing logged it. The only place that shows up is
// the invoice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDraftSpend, decideSpend, applyCharge } from './semrush-budget.ts';

const FLOOR = 5000;

test('an unreadable balance closes the gate, it does not open it', () => {
  // This is the regression. `null` is what the caller passes when Semrush
  // answered with an HTML maintenance page, a login redirect, or anything else
  // parseInt turns into NaN.
  const d = decideSpend(null, 10, FLOOR, true);
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'balance-unknown');
});

test('NaN is treated as unknown, not as a number', () => {
  assert.equal(decideSpend(Number.NaN, 10, FLOOR, true).allow, false);
});

test('no API key means there is nothing to spend', () => {
  const d = decideSpend(9999, 1, FLOOR, false);
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'no-key');
});

test('a healthy balance above the floor allows the spend', () => {
  const d = decideSpend(9000, 100, FLOOR, true);
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'ok');
});

test('the floor is respected exactly', () => {
  assert.equal(decideSpend(5100, 100, FLOOR, true).allow, true, 'landing on the floor is allowed');
  assert.equal(decideSpend(5100, 101, FLOOR, true).allow, false, 'one unit below is refused');
  assert.equal(decideSpend(5100, 101, FLOOR, true).reason, 'below-floor');
});

test('a burst cannot all measure the same headroom', () => {
  // domainBundle fires four reports in a Promise.all. Without charging the
  // cache between them, each one saw the balance as it was before any of them
  // ran, and the floor could be overshot by the size of the burst.
  let balance: number | null = 5400;
  assert.equal(decideSpend(balance, 300, FLOOR, true).allow, true);
  balance = applyCharge(balance, 300); // first report lands
  assert.equal(balance, 5100);
  balance = applyCharge(balance, 300); // second report lands
  assert.equal(
    decideSpend(balance, 300, FLOOR, true).allow,
    false,
    'the third is now correctly refused instead of overshooting',
  );
});

test('charging ignores junk and never goes negative', () => {
  assert.equal(applyCharge(100, 0), 100);
  assert.equal(applyCharge(100, -5), 100);
  assert.equal(applyCharge(100, Number.NaN), 100);
  assert.equal(applyCharge(100, 500), 0, 'clamped at zero');
  assert.equal(applyCharge(null, 10), null, 'an unknown balance stays unknown');
});

test('the drafting pot: a month\u2019s spend plus this call must fit the allowance', () => {
  assert.deepEqual(decideDraftSpend(0, 500, 2500), { allow: true, reason: 'ok' });
  assert.deepEqual(decideDraftSpend(2000, 500, 2500), { allow: true, reason: 'ok' }, 'exactly to the line is allowed');
  assert.deepEqual(decideDraftSpend(2001, 500, 2500), { allow: false, reason: 'draft-pot' });
  assert.deepEqual(decideDraftSpend(2500, 40, 2500), { allow: false, reason: 'draft-pot' });
});

test('the drafting pot fails closed: an unreadable log or no pot at all refuses', () => {
  assert.equal(decideDraftSpend(null, 40, 2500).reason, 'draft-pot-unknown');
  assert.equal(decideDraftSpend(Number.NaN, 40, 2500).reason, 'draft-pot-unknown');
  assert.equal(decideDraftSpend(0, 40, 0).reason, 'draft-pot', 'SEMRUSH_DRAFT_ALLOWANCE=0 turns drafting research off');
  assert.equal(decideDraftSpend(0, 40, Number.NaN).reason, 'draft-pot');
});

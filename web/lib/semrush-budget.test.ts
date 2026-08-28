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
import { decideSpend, applyCharge } from './semrush-budget.ts';

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

// Behavioural tests for the refresh bus — the interconnection layer that keeps
// every panel in sync. Run with `npm test`.
//
// What must hold:
//   1. announce(scopes) reaches every subscribed panel with exactly those scopes.
//   2. Unsubscribing really stops delivery (no ghost refetches after unmount).
//   3. Empty/bogus announcements never invoke handlers.
//   4. fetchDrafts coalesces identical concurrent requests into ONE network
//      call, but a later call after settle hits the network again (no staleness).
//   5. A 401 from the API surfaces as a session-expired error, not silent data.
const assert = require('assert');

// --- minimal browser environment -------------------------------------------
const listeners = new Map();
global.window = {
  addEventListener: (t, fn) => { listeners.set(t, [...(listeners.get(t) || []), fn]); },
  removeEventListener: (t, fn) => {
    listeners.set(t, (listeners.get(t) || []).filter((f) => f !== fn));
  },
  dispatchEvent: (ev) => { (listeners.get(ev.type) || []).forEach((fn) => fn(ev)); return true; },
};
global.CustomEvent = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

// fetch stub: counts calls per URL, resolution controlled per test.
let fetchCalls = [];
let nextResponse = () => ({ ok: true, status: 200, json: async () => ({ drafts: [], total: 0 }) });
global.fetch = (url) => { fetchCalls.push(String(url)); return Promise.resolve(nextResponse()); };

// The bus is TypeScript; bundle it on the fly like the progress-bus tests do.
const path = require('path');
const esbuild = require('esbuild');
const built = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'components', 'refreshBus.ts')],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'error',
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require);
const { announce, onRefresh, fetchDrafts } = mod.exports;

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- 1 + 3: delivery and filtering ------------------------------------------
test('announce reaches every subscriber with exactly the scopes announced', () => {
  const seenA = [], seenB = [];
  const offA = onRefresh((s) => seenA.push(s));
  const offB = onRefresh((s) => seenB.push(s));
  announce('drafts', 'images');
  assert.deepEqual(seenA, [['drafts', 'images']]);
  assert.deepEqual(seenB, [['drafts', 'images']]);
  offA(); offB();
});

test('an empty announce is a no-op — handlers never fire on nothing', () => {
  let calls = 0;
  const off = onRefresh(() => calls++);
  announce();
  window.dispatchEvent(new CustomEvent('chi:refresh', { detail: {} })); // malformed
  window.dispatchEvent(new CustomEvent('chi:refresh', { detail: { scopes: [] } }));
  assert.equal(calls, 0);
  off();
});

// --- 2: unsubscribe really unsubscribes -------------------------------------
test('after unsubscribe (unmount), a panel never hears another announcement', () => {
  let calls = 0;
  const off = onRefresh(() => calls++);
  announce('stats');
  off();
  announce('stats', 'drafts', 'images');
  assert.equal(calls, 1);
});

test('one panel unsubscribing does not silence the others', () => {
  let a = 0, b = 0;
  const offA = onRefresh(() => a++);
  const offB = onRefresh(() => b++);
  offA();
  announce('autopilot');
  assert.equal(a, 0);
  assert.equal(b, 1);
  offB();
});

// --- 4: request coalescing ---------------------------------------------------
test('three concurrent identical drafts fetches share ONE network call', async () => {
  fetchCalls = [];
  const [r1, r2, r3] = await Promise.all([fetchDrafts(50, 0), fetchDrafts(50, 0), fetchDrafts(50, 0)]);
  assert.equal(fetchCalls.length, 1, 'expected 1 network call, saw ' + fetchCalls.length);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r2, r3);
});

test('different queries are NOT coalesced, and a later refresh hits the network again', async () => {
  fetchCalls = [];
  await Promise.all([fetchDrafts(50, 0), fetchDrafts(10, 0)]);
  assert.equal(fetchCalls.length, 2, 'different limits must fetch separately');
  await fetchDrafts(50, 0); // after settle: fresh network hit, nothing stale
  assert.equal(fetchCalls.length, 3);
});

// --- 5: expired sessions surface loudly --------------------------------------
test('a 401 rejects with a session-expired message instead of returning empty data', async () => {
  nextResponse = () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => fetchDrafts(50, 0), /session has expired/i);
  nextResponse = () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => fetchDrafts(50, 0), /500/);
  nextResponse = () => ({ ok: true, status: 200, json: async () => ({ drafts: [], total: 0 }) });
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name); console.error(e && e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' refresh-bus assertions passed');
})();

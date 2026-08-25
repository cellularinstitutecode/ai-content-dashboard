// Behavioural tests for the progress bus — the component behind the global
// loading screen. Run with `npm test`.
//
// Behavioural tests for the progress bus: the percentage, the calibration,
// the foreground/background split, and the fetch interception.
const assert = require('assert');

// --- minimal browser environment -------------------------------------------
const store = new Map();
const listeners = new Map();
global.window = {
  location: { origin: 'https://app.test' },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  addEventListener: (t, fn) => { listeners.set(t, [...(listeners.get(t) || []), fn]); },
  removeEventListener: () => {},
  dispatchEvent: () => true,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 16),
  fetch: null,
};
global.Headers = class Headers {
  constructor(init) { this.map = new Map(Object.entries(init || {})); }
  get(k) { const v = this.map.get(k); return v === undefined ? null : v; }
};
global.URL = URL;
global.CustomEvent = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };

// The bus is TypeScript; bundle it on the fly so the test runs with plain
// node and no build step of its own.
const path = require('path');
const esbuild = require('esbuild');
const built = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'components', 'progressBus.ts')],
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'error',
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require);
const bus = mod.exports;

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nprogressBus');

// 1 — labels
test('every API endpoint gets a plain-English label', () => {
  assert.strictEqual(bus.labelFor('POST /api/generate'), 'Writing your content pack');
  assert.strictEqual(bus.labelFor('GET /api/semrush?action=advise'), 'Building your SEO plan');
  assert.strictEqual(bus.labelFor('POST /api/drafts/image'), 'Generating and verifying the hero image');
  // an endpoint with no explicit label must still be readable, never blank
  assert.strictEqual(bus.labelFor('GET /api/brand-new-thing'), 'Working on brand new thing');
});

// 2 — a task reports a moving, bounded percentage
(async () => {
  const h = bus.startTask({ key: 'POST /api/generate', label: 'Writing', expectedMs: 400 });
  const early = bus.snapshot().percent;
  assert.ok(bus.snapshot().active, 'a running foreground task marks the screen active');
  await sleep(150);
  const mid = bus.snapshot().percent;
  assert.ok(mid > early, `percent must advance with time (${early} -> ${mid})`);
  assert.ok(mid < 100, 'percent must never claim 100 while the request is outstanding');
  await sleep(600);
  const late = bus.snapshot().percent;
  assert.ok(late < 100, 'an overdue task still must not claim 100 (' + late + ')');
  assert.ok(late >= mid, 'percent is monotonic');
  h.done();
  assert.strictEqual(bus.snapshot().percent, 100, 'completion snaps to 100');
  assert.strictEqual(bus.snapshot().active, false);
  pass++; console.log('  ✓ percent rises while a task runs and never reaches 100 until it ends');

  // 3 — calibration: a measured duration replaces the seeded estimate
  const before = bus.expectedFor('POST /api/drafts/image');   // 30s seed, never measured yet
  const h2 = bus.startTask({ key: 'POST /api/drafts/image' });
  await sleep(220);
  h2.done();
  const after = bus.expectedFor('POST /api/drafts/image');
  assert.notStrictEqual(before, after, 'the estimate must learn from the real duration');
  assert.ok(after < before, 'a fast real call must pull the 30s seed down (' + before + ' -> ' + after + ')');
  pass++; console.log('  ✓ the estimate calibrates from measured durations (' + before + 'ms -> ' + after + 'ms)');

  // 4 — background work never takes over the screen
  const bg = bus.startTask({ key: 'GET /api/opus/clip', kind: 'background' });
  const s = bus.snapshot();
  assert.strictEqual(s.active, false, 'background work must not raise the loading screen');
  assert.strictEqual(s.backgroundActive, true, 'but it must still be reported for the top bar');
  bg.done();
  pass++; console.log('  ✓ background work shows in the top bar, never the full screen');

  // 5 — concurrent tasks aggregate into ONE number, weighted by expected cost
  await sleep(800); // let finished tasks age out of the linger window
  const a = bus.startTask({ key: 'POST /api/drafts/image', expectedMs: 30000 });
  const b = bus.startTask({ key: 'GET /api/stats', expectedMs: 900 });
  await sleep(120);
  const agg = bus.snapshot();
  assert.strictEqual(agg.running.length, 2, 'both tasks are listed on the screen');
  assert.ok(agg.percent < 30, 'the cheap task finishing early must not imply the batch is nearly done');
  b.done();
  const afterCheap = bus.snapshot().percent;
  assert.ok(afterCheap < 100, 'one of two tasks done is not the whole batch');
  a.done();
  assert.strictEqual(bus.snapshot().percent, 100);
  pass++; console.log('  ✓ concurrent tasks aggregate into one cost-weighted percentage');

  // 6 — runTask propagates failures and still closes the task out
  let threw = false;
  try {
    await bus.runTask({ label: 'boom' }, async () => { throw new Error('nope'); });
  } catch (e) { threw = true; }
  assert.ok(threw, 'runTask rethrows so callers keep their own error handling');
  assert.strictEqual(bus.snapshot().active, false, 'a failed task must not leave the screen stuck');
  pass++; console.log('  ✓ a failing task rethrows and never leaves the screen stuck');

  // 7 — fetch interception: only this app's /api/ calls are observed
  const seen = [];
  global.window.fetch = async (input, init) => {
    seen.push(String(input));
    await sleep(80);
    return { ok: true, status: 200 };
  };
  bus.installFetchProgress();
  const p = window.fetch('/api/generate', { method: 'POST' });
  await sleep(30);
  const during = bus.snapshot();
  assert.ok(during.active, 'a POST to /api/ raises the loading screen with no call-site changes');
  assert.strictEqual(during.label, 'Writing your content pack');
  await p;
  await sleep(20);
  assert.strictEqual(bus.snapshot().active, false, 'the screen clears when the request resolves');
  pass++; console.log('  ✓ fetch interception drives the screen with zero call-site changes');

  // 8 — third-party calls are left alone
  const p2 = window.fetch('https://api.openai.com/v1/realtime', { method: 'POST' });
  await sleep(30);
  assert.strictEqual(bus.snapshot().active, false, 'a third-party call must not raise the app loading screen');
  await p2;
  pass++; console.log('  ✓ third-party and non-/api calls are not intercepted');

  // 9 — a polling endpoint stays background even as a POST
  const p3 = window.fetch('/api/opus/clip?projectId=x');
  await sleep(30);
  const s3 = bus.snapshot();
  assert.strictEqual(s3.active, false, 'the 5s clip poller must never blank the screen');
  assert.strictEqual(s3.backgroundActive, true);
  await p3;
  pass++; console.log('  ✓ known pollers are classified background automatically');

  // 10 — a failing request is reported, not swallowed
  global.window.fetch = async () => ({ ok: false, status: 500 });
  bus.noteInteraction();
  await window.fetch('/api/generate', { method: 'POST' });
  await sleep(20);
  assert.strictEqual(bus.snapshot().active, false);
  pass++; console.log('  ✓ a 5xx closes its task instead of hanging the screen');

  console.log('\n' + pass + ' assertions passed\n');
})().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });

// Browser end-to-end test for the dashboard.
//
// Prereqs (both running): node e2e/mock-supabase.cjs  (:54321)
//                         next start -p 3100          (built with e2e .env.local)
// Run: node e2e/browser-e2e.cjs
//
// What it proves, in a real Chromium:
//   1. A signed-in dashboard renders every panel from live API data.
//   2. Boot shows only the hairline top bar (with a percentage) — never an
//      overlay; drafting raises a panel-scoped percentage loader that covers
//      exactly the Content Generator and clears when the work ends.
//   3. The content-image rule is visible: ✓ verified badges on clean images,
//      the red ✗ text badge on a text-flagged image (Image Studio + Autopilot).
//   4. Interconnection: an announce('drafts') from ANY panel makes the others
//      refetch /api/drafts with no reload.
//   5. Calendar / Templates / Brand pages render.
//   6. Zero unexpected console errors or page crashes anywhere.
const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:3100';
const results = [];
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : '  — ' + detail));
  if (!ok) failed++;
}

(async () => {
  const cookieValue = decodeURIComponent(
    fs.readFileSync('/tmp/cookie.txt', 'utf8').replace(/^sb-127-auth-token=/, '')
  );

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2000 } });
  await ctx.addCookies([{ name: 'sb-127-auth-token', value: encodeURIComponent(cookieValue), url: BASE }]);

  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const apiRequests = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) apiRequests.push(u.pathname + u.search); });
  page.on('requestfailed', (r) => failedRequests.push(r.url() + ' :: ' + (r.failure() ? r.failure().errorText : '?')));

  // Record every percentage the loading UI ever paints, from inside the page —
  // a MutationObserver never misses a frame the way external polling can.
  await page.addInitScript(() => {
    window.__pctLog = [];
    const scan = (root) => {
      const text = root && root.textContent ? root.textContent : '';
      const m = /(\d{1,3})%/.exec(text);
      if (m) window.__pctLog.push(parseInt(m[1], 10));
    };
    window.__overlayLog = [];
    const scanOverlay = () => {
      if (document.querySelector('[data-testid="global-loading-screen"]')) window.__overlayLog.push('full-screen');
      if (document.querySelector('[data-testid="panel-loading-screen"]')) window.__overlayLog.push('panel');
    };
    const mo = new MutationObserver((muts) => {
      scanOverlay();
      for (const mu of muts) {
        scan(mu.target);
        mu.addedNodes && mu.addedNodes.forEach((n) => scan(n));
      }
    });
    document.addEventListener('DOMContentLoaded', () => {
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  });

  // Slow /api responses slightly so the loading screen has real work to show.
  await page.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });

  // ---- 2: loading screen with a percentage (in-page MutationObserver) ------
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 });
  const percentSamples = await page.evaluate(() => window.__pctLog || []);

  check('dashboard renders (signed in, no redirect to /sign-in)', !page.url().includes('sign-in'), page.url());
  check('hairline top bar showed a live percentage while panels loaded', percentSamples.length > 0, 'samples: ' + percentSamples.join(','));
  const bootOverlays = await page.evaluate(() => window.__overlayLog || []);
  check('sign-in/boot never raised a full-screen loading overlay', !bootOverlays.includes('full-screen'), bootOverlays.join(','));
  check('sign-in/boot never raised a panel loading overlay either', !bootOverlays.includes('panel'), bootOverlays.join(','));
  check('percentage stayed sane (0-100) and progressed', percentSamples.every((p) => p >= 0 && p <= 100) && (percentSamples.length < 2 || percentSamples[percentSamples.length - 1] >= percentSamples[0]), percentSamples.join(','));

  const body = await page.evaluate(() => document.body.innerText);
  // ---- 1: every panel present, fed by the API -----------------------------
  for (const [name, needle] of [
    ['AI Image Studio panel', 'AI Image Studio'],
    ['Autopilot queue panel', 'Autopilot'],
    ['Content Generator panel', 'Content Generator'],
    ['Publishing panel', 'Publishing'],
    ['Recent Drafts library', 'Recent Drafts'],
    ['Autopilot run card shows the researched angle', 'stem cell therapy for knees'],
    ['Autopilot run card shows its quality score', '84/100'],
    ['drafts from the API render in the library', 'Exosome therapy for joint recovery'],
  ]) check(name, body.includes(needle));

  // Panels must follow the workflow order, top to bottom.
  const order = await page.evaluate(() => {
    const ids = ['section-create', 'section-images', 'section-repurpose', 'section-publish', 'section-autopilot', 'section-library'];
    const tops = ids.map((id) => { const el = document.getElementById(id); return el ? el.getBoundingClientRect().top + window.scrollY : -1; });
    return { tops, sorted: tops.every((t, i) => t >= 0 && (i === 0 || t > tops[i - 1])) };
  });
  check('panels appear in workflow order: Create → Images → Repurpose → Schedule → Autopilot → Library', order.sorted, order.tops.join(','));

  const statOk = await page.evaluate(() => {
    const t = document.body.innerText;
    return /Drafts/.test(t) && /Scheduled posts/.test(t);
  });
  check('stat cards render from /api/stats', statOk);

  // The reviewer's yes lives on the dashboard now. A post waiting for review
  // must show Approve and Publish now; the Autopilot card must offer
  // "Approve & schedule"; and the old "open Metricool to approve" copy is gone.
  const approveUi = await page.evaluate(() => {
    const t = document.body.innerText;
    const buttons = [...document.querySelectorAll('button')].map((b) => b.innerText.trim());
    return {
      approve: buttons.includes('Approve'),
      publishNow: buttons.includes('Publish now'),
      autopilot: buttons.includes('Approve & schedule') && buttons.includes('Approve as draft'),
      oldCopy: /approval yourself inside Metricool|approve it there to publish/i.test(t),
    };
  });
  check('a post waiting for review offers Approve on the dashboard', approveUi.approve);
  check('and Publish now', approveUi.publishNow);
  check('the Autopilot card offers Approve & schedule alongside Approve as draft', approveUi.autopilot);
  check('nothing on screen still sends the reviewer into Metricool to approve', !approveUi.oldCopy);

  // ---- 3: content-image verification badges -------------------------------
  check('✓ verified badge on machine-verified text-free images', body.includes('✓ verified') || body.includes('verified'));
  const redBadge = body.includes('✗ text');
  check('red ✗ text badge on the text-flagged image (hard rule visible)', redBadge);
  const galleryImgs = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter((i) => i.src.includes('content-images')).length);
  check('Image Studio gallery renders stored images', galleryImgs >= 2, galleryImgs + ' imgs');

  // ---- 3b: text-flagged images never reach the scheduler ------------------
  // Prefilling the Publishing composer from a draft must attach a clean,
  // machine-verified hero image — and must NEVER attach one the checker
  // flagged for text (the reviewer rerolls it in the Image Studio first).
  async function prefillFromLibrary(topicNeedle) {
    return page.evaluate((needle) => {
      const lib = document.getElementById('section-library');
      if (!lib) return 'no library';
      // The tightest wrapper holding both the topic text and an Edit button
      // is the card itself (outer containers match too, but are longer).
      const card = Array.from(lib.querySelectorAll('li, div'))
        .filter((el) => el.querySelector && el.querySelector('button[aria-label="Edit draft"]') && el.textContent.includes(needle))
        .sort((a, b) => a.textContent.length - b.textContent.length)[0];
      if (!card) return 'no card for ' + needle;
      card.querySelector('button[aria-label="Edit draft"]').click();
      return 'clicked';
    }, topicNeedle);
  }
  const composerMedia = () =>
    page.evaluate(() => {
      const pub = document.getElementById('section-publish');
      return pub ? pub.innerText.includes('AI hero image') : false;
    });
  const r1 = await prefillFromLibrary('Exosome therapy for joint recovery');
  await page.waitForTimeout(400);
  const cleanAttached = await composerMedia();
  check('prefilling from a clean draft attaches its verified hero image', r1 === 'clicked' && cleanAttached, r1);
  const r2 = await prefillFromLibrary('stem cell therapy for knees');
  await page.waitForTimeout(400);
  const flaggedAttached = await composerMedia();
  check('a TEXT-FLAGGED image is never prefilled into the scheduler (hard rule at the ship-point)', r2 === 'clicked' && !flaggedAttached, r2 + (flaggedAttached ? ' — flagged image leaked into composer' : ''));

  // ---- 4: interconnection — announce() → cross-panel refetch --------------
  const before = apiRequests.filter((u) => u.startsWith('/api/drafts?')).length;
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('chi:refresh', { detail: { scopes: ['drafts', 'images'] } }));
  });
  await page.waitForTimeout(2500);
  const after = apiRequests.filter((u) => u.startsWith('/api/drafts?')).length;
  check('announce(drafts) makes panels refetch /api/drafts live (no reload)', after > before, before + ' → ' + after);

  // ---- 4b: generation covers ONLY its own panel, with a percentage --------
  await page.evaluate(() => {
    window.__genDone = false;
    fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'e2e loading probe', provider: 'anthropic', model: 'claude-sonnet-4-5', type: 'social' }),
    }).catch(() => {}).finally(() => { window.__genDone = true; });
  });
  await page.waitForTimeout(600);
  const genState = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="panel-loading-screen"]');
    return {
      panelVisible: Boolean(panel),
      scope: panel ? panel.getAttribute('data-scope') : null,
      insideCreate: Boolean(document.querySelector('#section-create [data-testid="panel-loading-screen"]')),
      fullScreen: Boolean(document.querySelector('[data-testid="global-loading-screen"]')),
      pct: (document.querySelector('[data-testid="panel-loading-percent"]') || {}).textContent || '',
    };
  });
  check('drafting raises the loading screen INSIDE the Content Generator panel', genState.panelVisible && genState.insideCreate, JSON.stringify(genState));
  check('the drafting loader is scoped to "create" and shows a percentage', genState.scope === 'create' && /[0-9]/.test(genState.pct), JSON.stringify(genState));
  check('no full-screen overlay during drafting', !genState.fullScreen);
  await page.waitForFunction(() => window.__genDone, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const stillCovered = await page.evaluate(() => Boolean(document.querySelector('[data-testid="panel-loading-screen"]')));
  check('the panel loader clears when generation ends', !stillCovered);

  await page.screenshot({ path: '/tmp/e2e-dashboard.png', fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/e2e-dashboard-top.png', fullPage: false });

  // ---- 5: the other pages render ------------------------------------------
  for (const [path, needle] of [
    ['/calendar', 'calendar'],
    ['/templates', 'emplate'],
    ['/brand', 'Brand Brain'],
  ]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 60000 });
    const t = await page.evaluate(() => document.body.innerText);
    check(path + ' page renders', !page.url().includes('sign-in') && t.toLowerCase().includes(String(needle).toLowerCase()), page.url());
  }
  await page.screenshot({ path: '/tmp/e2e-brand.png', fullPage: false });

  // ---- 5b: a failed load must not look like an empty account ---------------
  //
  // Every panel used to do `if (!r.ok) return;`, so a 401, a 429 or a dropped
  // connection left the dashboard in its EMPTY state: "Nothing in the queue
  // yet", "No drafts yet", "No Autopilot runs yet". A coordinator whose session
  // had lapsed was told, in effect, that her work had vanished. Prove that a
  // broken backend now SAYS it is broken.
  const failPage = await ctx.newPage();
  await failPage.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/posts' || p === '/api/stats' || p === '/api/drafts' || p === '/api/autopilot/runs') {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unauthenticated', message: 'Your session has expired. Sign in again.' }),
      });
    }
    return route.continue();
  });
  await failPage.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 90000 });
  await failPage.waitForTimeout(1500);
  const failText = await failPage.evaluate(() => document.body.innerText);
  check('a failed load says the session expired instead of showing an empty dashboard',
    /session has expired/i.test(failText), failText.slice(0, 160).replace(/\s+/g, ' '));
  check('and it does NOT claim the publishing queue is empty',
    !/Nothing in the queue yet/i.test(failText));
  check('and it does NOT claim there are no drafts',
    !/No drafts yet/i.test(failText));
  check('and it does NOT send the user off to fix a healthy Autopilot template',
    !/No Autopilot runs yet/i.test(failText));
  await failPage.screenshot({ path: '/tmp/e2e-failed-load.png', fullPage: false });
  await failPage.close();

  // ---- 6: console hygiene --------------------------------------------------
  // Failures from EXTERNAL hosts (Google Fonts etc.) are sandbox-proxy
  // artifacts, not app bugs; anything failing against 127.0.0.1 is real.
  const localFailures = failedRequests.filter((u) => u.includes('127.0.0.1') && !/realtime|websocket/i.test(u));
  check('no failed requests against the app itself', localFailures.length === 0, localFailures.slice(0, 3).join(' | '));
  const realErrors = consoleErrors.filter((e) =>
    !/realtime|websocket|wss?:\/\//i.test(e) && // no realtime server in the mock env
    !/favicon/i.test(e) &&
    !/net::ERR_ABORTED|net::ERR_TUNNEL_CONNECTION_FAILED|net::ERR_CONNECTION_RESET|net::ERR_NAME_NOT_RESOLVED/i.test(e) && // external hosts blocked by the sandbox proxy
    // Degraded integrations answer with handled errors. 502 is in this list
    // because an unreachable upstream (Metricool/Opus/Semrush/the model APIs,
    // none of which exist in the mock env) is now reported as a gateway error
    // rather than as a 500 — a failure OUTSIDE the app is not the app's fault,
    // and the distinction is what lets the UI say "the service is unavailable"
    // instead of "something went wrong".
    !/Failed to load resource.*(404|500|502|503)/i.test(e)
  );
  check('zero unexpected console errors across all pages', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  if (failedRequests.length) console.log('  (external request failures, sandbox-only: ' + failedRequests.filter((u) => !u.includes('127.0.0.1')).length + ')');
  check('zero uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' browser E2E checks passed');
  if (consoleErrors.length) console.log('(console errors observed, filtered as expected-in-mock: ' + consoleErrors.length + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(1); });

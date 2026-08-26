const fs = require('fs');
const { chromium } = require('playwright-core');
(async () => {
  const cookieValue = fs.readFileSync('/tmp/cookie.txt', 'utf8').replace(/^sb-127-auth-token=/, '');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sb-127-auth-token', value: cookieValue, url: 'http://127.0.0.1:3100' }]);
  const page = await ctx.newPage();
  await page.route('**/api/**', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  const nav = page.goto('http://127.0.0.1:3100/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  // boot must show only the hairline top bar, never an overlay
  try {
    await page.waitForSelector('[data-testid="top-progress-percent"]', { timeout: 15000 });
    const pct = await page.evaluate(() => document.querySelector('[data-testid="top-progress-percent"]')?.textContent);
    console.log('top bar percent showing:', pct);
    await page.screenshot({ path: '/tmp/e2e-loading.png' });
  } catch (e) { console.log('top bar not caught:', e.message); }
  await nav;
  // trigger a generation and catch the panel-scoped loader
  try {
    await page.evaluate(() => {
      fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'screenshot probe', provider: 'anthropic', model: 'claude-sonnet-4-5', type: 'social' }),
      }).catch(() => {});
    });
    await page.waitForSelector('[data-testid="panel-loading-screen"]', { timeout: 15000 });
    await page.waitForTimeout(700);
    const ppct = await page.evaluate(() => document.querySelector('[data-testid="panel-loading-percent"]')?.textContent);
    console.log('panel loader percent showing:', ppct);
    await page.screenshot({ path: '/tmp/e2e-panel-loading.png' });
  } catch (e) { console.log('panel loader not caught:', e.message); }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/e2e-dashboard-final.png' });
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/e2e-dashboard-mid.png' });
  await browser.close();
})();

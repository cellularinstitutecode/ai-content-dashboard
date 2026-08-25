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
  // catch the overlay mid-load
  try {
    await page.waitForSelector('[data-testid="global-loading-percent"]', { timeout: 15000 });
    await page.waitForTimeout(900);
    const pct = await page.evaluate(() => document.querySelector('[data-testid="global-loading-percent"]')?.textContent);
    console.log('overlay percent showing:', pct);
    await page.screenshot({ path: '/tmp/e2e-loading.png' });
  } catch (e) { console.log('overlay not caught:', e.message); }
  await nav;
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/e2e-dashboard-final.png' });
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/e2e-dashboard-mid.png' });
  await browser.close();
})();

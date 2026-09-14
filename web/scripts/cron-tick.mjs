// scripts/cron-tick.mjs — what a Dokploy Schedule Job runs, in place of a Vercel cron.
//
//   node scripts/cron-tick.mjs metricool/sync
//
// Calls GET http://127.0.0.1:3000/api/<path> inside this same container with
// the Bearer CRON_SECRET every cron route already checks — exactly what
// Vercel's scheduler sends, so the routes cannot tell the difference. Exits
// non-zero on anything but a 2xx, so a failed run shows red in Dokploy's job
// log with the route's own answer in it. No dependencies: Node's fetch.
const target = String(process.argv[2] || '').replace(/^\/?(api\/)?/, '');
if (!target) {
  console.error('usage: node scripts/cron-tick.mjs <route under /api/>   e.g. metricool/sync');
  process.exit(2);
}
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error('CRON_SECRET is not set in this container; the route would answer 401.');
  process.exit(2);
}
const base = process.env.CRON_BASE_URL || 'http://127.0.0.1:' + (process.env.PORT || '3000');
const url = base.replace(/\/$/, '') + '/api/' + target;
const started = Date.now();
try {
  // The longest route (the Autopilot tick) budgets itself to 300 s.
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(310_000) });
  const body = (await res.text()).slice(0, 4000);
  console.log('[cron-tick] GET /api/' + target + ' -> ' + res.status + ' in ' + Math.round((Date.now() - started) / 1000) + 's');
  console.log(body);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('[cron-tick] GET /api/' + target + ' failed: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

// The container's schedule list is a carbon copy of vercel.json's crons.
//
// Two hosts, one set of daily jobs. If somebody adds a cron to vercel.json
// and forgets deploy/dokploy-schedules.json (or the reverse), the two copies
// of the app quietly diverge — one sweeps the video sheet, the other does
// not — and nothing would say so. This does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));

type Cron = { path: string; schedule: string };
type Job = { name: string; path: string; cronExpression: string; command: string };

const vercel = (read('vercel.json').crons as Cron[]).map((c) => c.path + ' @ ' + c.schedule).sort();
const jobs = read('deploy/dokploy-schedules.json').schedules as Job[];

test('every Vercel cron has a Dokploy schedule with the same path and time, and no extras', () => {
  const dokploy = jobs.map((j) => j.path + ' @ ' + j.cronExpression).sort();
  assert.deepEqual(dokploy, vercel, 'vercel.json crons and deploy/dokploy-schedules.json have drifted apart');
});

test('each schedule runs cron-tick against its own path', () => {
  for (const j of jobs) {
    const route = j.path.replace(/^\/api\//, '');
    assert.equal(j.command, 'node scripts/cron-tick.mjs ' + route, j.name + ' does not call its own route');
    assert.match(j.name, /^[a-z0-9-]+$/, 'schedule names are plain slugs');
  }
});

test('cron-tick exists where the Dockerfile copies it from', () => {
  const src = readFileSync(new URL('../scripts/cron-tick.mjs', import.meta.url), 'utf8');
  assert.match(src, /authorization: 'Bearer ' \+ secret/, 'the tick must send the same header Vercel does');
  assert.match(src, /process\.exit\(res\.ok \? 0 : 1\)/, 'a non-2xx must fail the job');
});

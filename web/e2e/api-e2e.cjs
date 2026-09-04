// API-level end-to-end tests for the launch-blocker fixes.
//
// Runs against the REAL built app (next start) with the mock Supabase backend
// and the mock Metricool scheduler, using a forged session cookie. Everything
// here is a behaviour that used to be broken in a way no test could see:
//
//   * "Apply template" created local rows that were never sent anywhere.
//   * A second Apply duplicated every slot.
//   * An AI template produced a run of blank posts.
//   * Rescheduling moved the local row and left Metricool on the old date.
//   * There was no way to delete a scheduled post at all.
//
// Prereqs: node e2e/mock-supabase.cjs, node e2e/mock-metricool.cjs,
//          next start -p 3100 built with METRICOOL_API_BASE pointing at the mock.
const fs = require('fs');
const assert = require('assert');

const BASE = 'http://127.0.0.1:3100';
const MC = 'http://127.0.0.1:54322';
const SB = 'http://127.0.0.1:54321';
const COOKIE = 'sb-127-auth-token=' + fs.readFileSync('/tmp/cookie.txt', 'utf8');
const USER_ID = '11111111-1111-4111-8111-111111111111';

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : '  — ' + detail));
  if (!ok) failed++;
}
const app = (path, init = {}) =>
  fetch(BASE + path, { ...init, headers: { cookie: COOKIE, ...(init.headers || {}) } });
const mc = async (path, init) => (await fetch(MC + path, init)).json();
const jsonOf = async (r) => { try { return await r.json(); } catch { return null; } };

(async () => {
  // ---------------------------------------------------------------- setup ---
  // Both backends start from their seed, so the suite is repeatable.
  await fetch(SB + '/__reseed', { method: 'POST' });
  await mc('/__reset');
  // A static template with real text — the kind Apply is for.
  const mkTemplate = await app('/api/templates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'E2E weekly tip',
      providers: ['facebook'],
      text: 'Weekly recovery tip from the clinic.',
      weekdays: [1, 3],
      time_of_day: '09:00',
      active: true,
      strategy: { mode: 'off' },
    }),
  });
  const tplBody = await jsonOf(mkTemplate);
  const tplId = tplBody && (tplBody.template?.id || tplBody.id);
  check('created a static template to apply', mkTemplate.ok && Boolean(tplId), String(mkTemplate.status));

  // ------------------------------------------------- apply reaches Metricool -
  const r1 = await app('/api/templates/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: tplId, weeks: 2 }),
  });
  const a1 = await jsonOf(r1);
  check('apply succeeds', r1.ok, r1.status + ' ' + JSON.stringify(a1));
  check('apply created posts', (a1?.created || 0) > 0, JSON.stringify(a1));

  const sent = (await mc('/__requests')).filter((q) => q.method === 'POST');
  check('every applied slot was actually sent to Metricool',
    sent.length === a1.created, sent.length + ' upstream POSTs for ' + a1.created + ' posts');
  check('Metricool received them as DRAFTS, never auto-published',
    sent.length > 0 && sent.every((q) => q.body?.draft === true && q.body?.autoPublish === false),
    JSON.stringify(sent[0]?.body));
  check('every upstream call carried the auth header and the blog id',
    sent.every((q) => q.auth && q.blogId), JSON.stringify({ auth: Boolean(sent[0]?.auth), blogId: sent[0]?.blogId }));

  // The clinic clock: a 09:00 template must reach Metricool as 09:00 local.
  check('a 09:00 template is sent as 09:00 on the clinic clock, not UTC',
    sent.every((q) => /T09:00:00$/.test(q.body?.publicationDate?.dateTime || '')
      && q.body?.publicationDate?.timezone === 'America/Cancun'),
    JSON.stringify(sent[0]?.body?.publicationDate));

  let posts = (await jsonOf(await app('/api/posts')))?.posts || [];
  const applied = posts.filter((p) => p.text === 'Weekly recovery tip from the clinic.');
  check('each stored post carries its Metricool id (so it can be moved or deleted later)',
    applied.length > 0 && applied.every((p) => p.metricool_post_id), JSON.stringify(applied[0]));
  check('the stored instant is 14:00Z — 09:00 in Cancun',
    applied.every((p) => /T14:00:00/.test(new Date(p.publication_date).toISOString())),
    applied[0] && new Date(applied[0].publication_date).toISOString());

  // ----------------------------------------------------------- idempotency --
  const before = (await mc('/__requests')).filter((q) => q.method === 'POST').length;
  const r2 = await app('/api/templates/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: tplId, weeks: 2 }),
  });
  const a2 = await jsonOf(r2);
  const after = (await mc('/__requests')).filter((q) => q.method === 'POST').length;
  check('applying the same template twice creates nothing new', (a2?.created || 0) === 0, JSON.stringify(a2));
  check('and sends nothing new to Metricool', after === before, before + ' → ' + after);
  check('it says what it skipped rather than claiming success', (a2?.skipped || 0) > 0, JSON.stringify(a2));

  const posts2 = (await jsonOf(await app('/api/posts')))?.posts || [];
  const slots = posts2.filter((p) => p.text === 'Weekly recovery tip from the clinic.').map((p) => p.publication_date);
  check('no duplicate slots exist', new Set(slots).size === slots.length, slots.length + ' rows, ' + new Set(slots).size + ' distinct');

  // --------------------------------------------- AI templates are refused ----
  const aiApply = await app('/api/templates/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'tpl-1', weeks: 2 }),   // seeded pillars template, no text
    });
  const aiBody = await jsonOf(aiApply);
  check('an AI template cannot be applied into blank posts', aiApply.status === 400 && aiBody?.error === 'template_has_no_text', aiApply.status + ' ' + JSON.stringify(aiBody));
  check('and it explains where those posts actually come from', /Autopilot/i.test(aiBody?.message || ''), aiBody?.message);

  // ------------------------------------------------------------ reschedule --
  const target = applied[0];
  const newDate = new Date(new Date(target.publication_date).getTime() + 2 * 86400000).toISOString();
  const pr = await app('/api/posts', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: target.id, publication_date: newDate }),
  });
  check('rescheduling succeeds', pr.ok, String(pr.status));
  const puts = (await mc('/__requests')).filter((q) => q.method === 'PUT');
  check('rescheduling actually moves the post in Metricool', puts.length === 1, puts.length + ' PUTs');
  check('the new time is sent on the clinic clock', /T09:00:00$/.test(puts[0]?.body?.publicationDate?.dateTime || ''), JSON.stringify(puts[0]?.body));
  // Metricool's PUT is a replace: a body with only the new date is rejected
  // with 400 ValidationError { text, providers }. Shipping that once is why
  // this assertion exists.
  check('the update carries the whole post, not just the new date',
    Boolean(puts[0]?.body?.text) && Array.isArray(puts[0]?.body?.providers) && puts[0].body.providers.length > 0,
    JSON.stringify(puts[0]?.body));
  check('and it stays a review draft through the update',
    puts[0]?.body?.draft === true && puts[0]?.body?.autoPublish === false, JSON.stringify(puts[0]?.body));
  const moved = ((await jsonOf(await app('/api/posts')))?.posts || []).find((p) => p.id === target.id);
  check('and the local row moved too', new Date(moved.publication_date).toISOString() === newDate, moved && moved.publication_date);

  // ------------------------------------------- reschedule fails CLOSED -------
  await fetch(MC + '/__fail?method=PUT');
  const failDate = new Date(new Date(newDate).getTime() + 86400000).toISOString();
  const pr2 = await app('/api/posts', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: target.id, publication_date: failDate }),
  });
  const pr2Body = await jsonOf(pr2);
  check('when Metricool refuses the move, the request fails', pr2.status === 502, String(pr2.status));
  check('and it says so in plain words', /Metricool/i.test(pr2Body?.message || ''), pr2Body?.message);
  const notMoved = ((await jsonOf(await app('/api/posts')))?.posts || []).find((p) => p.id === target.id);
  check('the local row is LEFT ALONE, so the two can never disagree',
    new Date(notMoved.publication_date).toISOString() === newDate, notMoved && notMoved.publication_date);
  await fetch(MC + '/__fail?method=PUT&off=1');

  // ---------------------------------------------------------------- delete ---
  await fetch(MC + '/__fail?method=DELETE');
  const dFail = await app('/api/posts?id=' + encodeURIComponent(target.id), { method: 'DELETE' });
  check('a delete that Metricool refuses does not remove the local row', dFail.status === 502, String(dFail.status));
  const stillThere = ((await jsonOf(await app('/api/posts')))?.posts || []).some((p) => p.id === target.id);
  check('the post is still in the queue after a refused delete', stillThere);
  await fetch(MC + '/__fail?method=DELETE&off=1');

  // The refused attempt above also reached the mock, so count the delta rather
  // than the total.
  const delsBefore = (await mc('/__requests')).filter((q) => q.method === 'DELETE').length;
  const del = await app('/api/posts?id=' + encodeURIComponent(target.id), { method: 'DELETE' });
  check('deleting a scheduled post succeeds', del.ok, String(del.status));
  const dels = (await mc('/__requests')).filter((q) => q.method === 'DELETE');
  check('it is removed from Metricool as well as from here',
    dels.length === delsBefore + 1 && dels[dels.length - 1].path.endsWith('/' + target.metricool_post_id),
    dels.length + ' DELETEs, last path ' + dels[dels.length - 1]?.path);
  const gone = ((await jsonOf(await app('/api/posts')))?.posts || []).some((p) => p.id === target.id);
  check('and it is gone from the queue', !gone);

  // ------------------------------------------- failed runs stay visible ------
  await fetch(SB + '/rest/v1/template_runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify([{
      id: 'run-old-failed',
      user_id: USER_ID,
      template_id: 'tpl-1',
      // Three weeks in the past: outside the queue's 24-hour window.
      scheduled_for: new Date(Date.now() - 21 * 86400000).toISOString(),
      state: 'failed',
      attempts: 2,
      log: [{ at: new Date().toISOString(), step: 'expired', note: 'Its scheduled time passed before this post was ready.' }],
    }]),
  });
  const runsBody = await jsonOf(await app('/api/autopilot/runs'));
  check('a run that failed weeks ago is still shown, so "Needs attention" can never be falsely empty',
    Array.isArray(runsBody?.runs) && runsBody.runs.some((r) => r.id === 'run-old-failed'),
    JSON.stringify((runsBody?.runs || []).map((r) => r.id)));

  // ------------------------------------- a failed step is COUNTED, not free ---
  //
  // `attempts` used to be incremented only inside the catch block, so a step
  // killed by the function timeout never counted and the run stayed eligible
  // forever - the same research + draft (a dozen Semrush reports and a full
  // model call) re-ran every day at full cost, and MAX_ATTEMPTS never tripped
  // so nothing ever surfaced as "Needs attention". The attempt is now claimed
  // BEFORE the step runs. This test pins the observable half of that: after a
  // tick in which a step fails, the run must carry the attempt.
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await fetch(SB + '/rest/v1/template_runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify([{
      id: 'run-due-for-attempt',
      template_id: 'tpl-1',
      user_id: USER_ID,
      scheduled_for: dueAt,          // inside the template's lead window
      state: 'planned',
      attempts: 0,
      regens: 0,
      log: [],
    }]),
  });
  await fetch(BASE + '/api/autopilot/tick', { headers: { authorization: 'Bearer e2e-cron-secret' } });
  const afterTick = await jsonOf(await fetch(SB + '/rest/v1/template_runs?id=eq.run-due-for-attempt'));
  const dueRun = Array.isArray(afterTick) ? afterTick[0] : null;
  check('a step that fails leaves the attempt counted on the run',
    Boolean(dueRun) && (dueRun.attempts || 0) >= 1,
    dueRun ? 'attempts=' + dueRun.attempts + ' state=' + dueRun.state : 'run not found');
  check('and the reason is written into the run log a human can read',
    Boolean(dueRun) && Array.isArray(dueRun.log) && dueRun.log.some((l) => l && l.step === 'error'),
    dueRun && JSON.stringify((dueRun.log || []).map((l) => l && l.step)));

  // ------------------------------------------------------- cron still guarded -
  const noAuth = await fetch(BASE + '/api/autopilot/tick');
  check('the tick still refuses an unauthenticated caller', noAuth.status === 401, String(noAuth.status));
  const badBearer = await fetch(BASE + '/api/autopilot/tick', { headers: { authorization: 'Bearer nope' } });
  check('and still refuses a wrong bearer', badBearer.status === 401, String(badBearer.status));
  const goodTick = await fetch(BASE + '/api/autopilot/tick', { headers: { authorization: 'Bearer e2e-cron-secret' } });
  const tickBody = await jsonOf(goodTick);
  check('the cron tick runs with the right secret', goodTick.ok && tickBody?.ok === true, goodTick.status + ' ' + JSON.stringify(tickBody));
  check('and it now reports how many stale runs it closed out', typeof tickBody?.expired === 'number', JSON.stringify(tickBody));

  // ------------------------------------------- the migration nobody ran -----
  // Every migration here is a .sql file a human is asked to paste into the
  // Supabase SQL editor, and nothing checked that they had: Autopilot could
  // fail on every tick forever while /api/health, which only read environment
  // variables, called the deployment healthy.
  const schemaOf = async () => {
    const j = await jsonOf(await app('/api/health'));
    return (j?.checks || []).find((c) => c.name === 'database_schema') || {};
  };
  const setMissing = (body) =>
    fetch(SB + '/__missing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await setMissing({});
  const migrated = await schemaOf();
  check('a fully migrated database passes the schema check', migrated.ok === true, JSON.stringify(migrated));

  await setMissing({ tables: ['template_runs'] });
  const noTable = await schemaOf();
  check('a missing table is caught', noTable.ok === false && noTable.code === 'migration_pending', JSON.stringify(noTable));
  check('and the detail names the file to run, not just the table',
    /template_runs/.test(noTable.detail || '') && /supabase\/autopilot\.sql/.test(noTable.detail || ''), noTable.detail);

  // The one a table-only probe would miss: schedule_templates.strategy is an
  // ALTER TABLE, so the table is present and the column is not.
  await setMissing({ columns: ['schedule_templates.strategy'] });
  const noColumn = await schemaOf();
  check('a missing COLUMN is caught, not just a missing table', noColumn.ok === false, JSON.stringify(noColumn));
  check('and it is named as a column so nobody hunts for a missing table',
    /schedule_templates\.strategy/.test(noColumn.detail || ''), noColumn.detail);

  await setMissing({});
  const recovered = await schemaOf();
  check('running the migration clears the check', recovered.ok === true, JSON.stringify(recovered));

  console.log('\n' + (failed === 0 ? 'all' : String(failed) + ' FAILED of') + ' API e2e checks');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

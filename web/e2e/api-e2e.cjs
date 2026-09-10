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
const GO = 'http://127.0.0.1:54325';
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
      // Facebook copy carries the two lines the advertising rule requires
      // (lib/compliance.ts); the rule itself is tested further down.
      text: 'Weekly recovery tip from the clinic.\n\nREF: Rogeri, P.S., et al. (2021). "Strategies to Prevent Sarcopenia in the Aging Process." Nutrients, 14(1), 52. DOI: 10.3390/nu14010052\n\nAVISO DE PUBLICIDAD: 2623022002A00090',
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
  const applied = posts.filter((p) => String(p.text || '').startsWith('Weekly recovery tip from the clinic.'));
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

  // ------------------------------------------------------ approve (the yes) --
  // A second applied slot, untouched so far, is the one we approve.
  const toApprove = applied[1];
  const putsBeforeApprove = (await mc('/__requests')).filter((q) => q.method === 'PUT').length;
  const ap = await app('/api/posts', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: toApprove.id, action: 'approve' }),
  });
  check('approving a reviewed post succeeds', ap.ok, String(ap.status) + ' ' + JSON.stringify(await jsonOf(ap)));
  const apPuts = (await mc('/__requests')).filter((q) => q.method === 'PUT').slice(putsBeforeApprove);
  check('approval is one replace in Metricool', apPuts.length === 1, apPuts.length + ' PUTs');
  check('and it moves the post to the LIVE queue (draft:false, autoPublish:true)',
    apPuts[0]?.body?.draft === false && apPuts[0]?.body?.autoPublish === true, JSON.stringify(apPuts[0]?.body));
  check('the approved post keeps its text, networks and time',
    Boolean(apPuts[0]?.body?.text) && apPuts[0]?.body?.providers?.length > 0 && /T\d\d:00:00$/.test(apPuts[0]?.body?.publicationDate?.dateTime || ''),
    JSON.stringify(apPuts[0]?.body));
  check('and a media list is always sent, so the picture cannot be dropped by the replace',
    Array.isArray(apPuts[0]?.body?.media), JSON.stringify(apPuts[0]?.body?.media));
  // Metricool keeps media only when the URL has been normalised first, and it
  // answers 200 either way — so "media was sent" never meant "media arrived".
  check('and every media entry is a normalised URL string, not a {url} object',
    (apPuts[0]?.body?.media || []).every((m) => typeof m === 'string'),
    JSON.stringify(apPuts[0]?.body?.media));
  const approvedRow = ((await jsonOf(await app('/api/posts')))?.posts || []).find((p) => p.id === toApprove.id);
  // 'approved', not 'scheduled': see lib/post-mode.ts. 'scheduled' is the
  // column default and Metricool's word for a post in its REVIEW queue, so it
  // cannot be the word that means a person said yes.
  check('the local row now reads approved', approvedRow?.status === 'approved', approvedRow?.status);
  const mcPost = (await mc('/__posts')).find((q) => String(q.id) === String(approvedRow?.metricool_post_id));
  check('Metricool holds it as live, not draft', mcPost && mcPost.draft === false && mcPost.autoPublish === true, JSON.stringify(mcPost));

  // A scheduled post that is moved must NOT fall back into review.
  const moveDate = new Date(new Date(toApprove.publication_date).getTime() + 3 * 86400000).toISOString();
  await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: toApprove.id, publication_date: moveDate }) });
  const lastPut = (await mc('/__requests')).filter((q) => q.method === 'PUT').pop();
  check('rescheduling an approved post keeps it approved (draft stays false)',
    lastPut?.body?.draft === false && lastPut?.body?.autoPublish === true, JSON.stringify(lastPut?.body));

  // Approving twice is a no-op with a plain explanation, not a second publish.
  const ap2 = await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: toApprove.id, action: 'approve' }) });
  check('approving an already-scheduled post is refused with a reason', ap2.status === 409 && /already/i.test((await jsonOf(ap2))?.message || ''), String(ap2.status));

  // A refused approval leaves the post waiting for review.
  const toRefuse = applied[2];
  await fetch(MC + '/__fail?method=PUT');
  const apFail = await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: toRefuse.id, action: 'approve' }) });
  const apFailBody = await jsonOf(apFail);
  check('when Metricool refuses the approval, nothing is scheduled', apFail.status === 502, String(apFail.status));
  check('and it says the post is still waiting for review', /still waiting/i.test(apFailBody?.message || ''), apFailBody?.message);
  const refusedRow = ((await jsonOf(await app('/api/posts')))?.posts || []).find((p) => p.id === toRefuse.id);
  check('the local row still says pending review', refusedRow?.status !== 'approved', refusedRow?.status);
  await fetch(MC + '/__fail?method=PUT&off=1');

  // Publish now dates the post a couple of minutes out and schedules it.
  const pn = await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: toRefuse.id, action: 'publish_now' }) });
  const pnBody = await jsonOf(pn);
  const pnLead = pnBody?.post ? (new Date(pnBody.post.publication_date).getTime() - Date.now()) / 1000 : -1;
  check('publish now succeeds', pn.ok, String(pn.status));
  check('and dates the post within the next few minutes', pnLead > 0 && pnLead < 600, String(pnLead));
  check('and it is approved, not left in review', pnBody?.post?.status === 'approved', pnBody?.post?.status);

  // ------------------------------------ moving is not approving -------------
  // Metricool answers with ITS word for a post's state, and that vocabulary
  // includes "scheduled" for a post it is holding in its REVIEW queue —
  // /api/metricool/schedule used to store that verbatim on our row, and
  // posts.status DEFAULTS to 'scheduled' in schema.sql besides. If either of
  // those counted as an approval, dragging a post nobody had read to another
  // day would publish it. (The column default itself is pinned in
  // lib/post-mode.test.ts: this mock stores what it is given and applies no
  // defaults, so only the values a row can actually carry are exercised here.)
  const mcForSafety = await (await fetch(MC + '/v2/scheduler/posts', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-auth': 'e2e-metricool-token' },
    body: JSON.stringify({ text: 'Never approved', providers: [{ network: 'facebook' }],
      publicationDate: { dateTime: '2026-12-01T10:00:00', timezone: 'America/Cancun' },
      media: [], draft: true, autoPublish: false }),
  })).json();
  let safetyN = 0;
  for (const status of ['scheduled', 'queued']) {
    // Explicit ids: the mock derives one from rows.length, which repeats after
    // a delete, and a repeated id makes .maybeSingle() match two rows.
    const rowId = 'never-approved-' + (++safetyN);
    await fetch(SB + '/rest/v1/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ id: rowId, user_id: USER_ID, providers: ['facebook'], text: 'Never approved\n\nREF: Rogeri, P.S., et al. (2021). Nutrients, 14(1), 52. DOI: 10.3390/nu14010052\n\nAVISO DE PUBLICIDAD: 2623022002A00090',
        publication_date: '2026-12-01T16:00:00.000Z', metricool_post_id: String(mcForSafety?.data?.id), status }]),
    });
    await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rowId, publication_date: '2026-12-04T16:00:00.000Z' }) });
    const moved = (await mc('/__requests')).filter((q) => q.method === 'PUT').pop();
    check('moving a post whose status is "' + status + '" does not publish it',
      moved?.body?.draft === true && moved?.body?.autoPublish === false,
      'sent draft=' + moved?.body?.draft + ' autoPublish=' + moved?.body?.autoPublish);
    const canApprove = await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rowId, action: 'approve' }) });
    check('and the reviewer can still approve it', canApprove.ok, String(canApprove.status) + ' ' + JSON.stringify(await jsonOf(canApprove)));
    const sent = (await mc('/__requests')).filter((q) => q.method === 'PUT').pop();
    check('and THAT is what sends it live',
      sent?.body?.draft === false && sent?.body?.autoPublish === true,
      'sent draft=' + sent?.body?.draft + ' autoPublish=' + sent?.body?.autoPublish);
  }

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
  // The writer (mock Anthropic, e2e/mock-google.cjs) is told to fail its next calls so the draft step breaks.
  await fetch('http://127.0.0.1:54325/__anthropic_fail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 3 }) });
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
  await fetch('http://127.0.0.1:54325/__anthropic_fail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 0 }) });

  // ------------------------------------------------------- cron still guarded -
  const noAuth = await fetch(BASE + '/api/autopilot/tick');
  check('the tick still refuses an unauthenticated caller', noAuth.status === 401, String(noAuth.status));
  const badBearer = await fetch(BASE + '/api/autopilot/tick', { headers: { authorization: 'Bearer nope' } });
  check('and still refuses a wrong bearer', badBearer.status === 401, String(badBearer.status));
  const goodTick = await fetch(BASE + '/api/autopilot/tick', { headers: { authorization: 'Bearer e2e-cron-secret' } });
  const tickBody = await jsonOf(goodTick);
  check('the cron tick runs with the right secret', goodTick.ok && tickBody?.ok === true, goodTick.status + ' ' + JSON.stringify(tickBody));
  check('and it now reports how many stale runs it closed out', typeof tickBody?.expired === 'number', JSON.stringify(tickBody));

  // ------------------------------------------------ the advertising rule -----
  // Every Instagram / Facebook post must carry "AVISO DE PUBLICIDAD: <permit>"
  // and a "REF:" line citing a study (lib/compliance.ts). Enforced at both
  // doors to Metricool; other networks are untouched.
  const G = 'http://127.0.0.1:54325';
  await fetch(G + '/__reset', { method: 'POST' }); // approvals below are written to the calendar sheet
  const COMPLIANT = 'Real clinic tip.\n\nREF: Djuricic, I., & Calder, P.C. (2021). Nutrients, 13(7), 2421. DOI: 10.3390/nu13072421\n\nAVISO DE PUBLICIDAD: 2623022002A00090';
  const sendFor = (network, text) => app('/api/metricool/schedule', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network, text, publishAt: new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 16), blogId: '4308292' }) });
  const bare = await sendFor('instagram', 'Real clinic tip with no lines.');
  const bareBody = await jsonOf(bare);
  check('an Instagram post without the notice and reference is refused before it reaches Metricool', bare.status === 422 && bareBody?.error === 'compliance', String(bare.status) + ' ' + JSON.stringify(bareBody));
  check('and the refusal names both missing lines', Array.isArray(bareBody?.missing) && bareBody.missing.includes('aviso') && bareBody.missing.includes('ref'), JSON.stringify(bareBody?.missing));
  check('and says it in plain words', /advertising notice/i.test(bareBody?.message || '') && /scientific reference/i.test(bareBody?.message || ''), bareBody?.message);
  const wrongPermit = await sendFor('facebook', COMPLIANT.replace('2623022002A00090', '1111111111A00001'));
  check('the wrong permit number is refused too', wrongPermit.status === 422 && /different permit/i.test((await jsonOf(wrongPermit))?.message || ''), String(wrongPermit.status));
  const okSend = await sendFor('facebook', COMPLIANT);
  check('a Facebook post carrying both lines goes through', okSend.ok, String(okSend.status) + ' ' + JSON.stringify(await jsonOf(okSend)));
  const linkedin = await sendFor('linkedin', 'LinkedIn copy has no such rule.');
  check('LinkedIn is not subject to the rule', linkedin.ok, String(linkedin.status));

  // The approval door: a post that reached the queue without the lines
  // (created before the rule, or edited in Metricool) cannot be approved.
  const compliantRow = ((await jsonOf(await app('/api/posts')))?.posts || []).find((p) => p.text === COMPLIANT && (p.providers || []).includes('facebook'));
  check('the compliant Facebook post landed in the queue with its Metricool id', Boolean(compliantRow?.metricool_post_id), JSON.stringify(compliantRow));
  const gateId = compliantRow?.id;
  await fetch(SB + '/rest/v1/posts?id=eq.' + encodeURIComponent(gateId), { method: 'PATCH', headers: { 'content-type': 'application/json', apikey: 'x' }, body: JSON.stringify({ text: 'Facebook draft with nothing.' }) });
  const apBare = await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: gateId, action: 'approve' }) });
  const putsBeforeGate = (await mc('/__requests')).filter((q) => q.method === 'PUT').length;
  check('approving a Facebook post without the lines is refused (422)', apBare.status === 422 && (await jsonOf(apBare))?.error === 'compliance', String(apBare.status));
  check('and nothing was sent to Metricool', (await mc('/__requests')).filter((q) => q.method === 'PUT').length === putsBeforeGate);
  await fetch(SB + '/rest/v1/posts?id=eq.' + encodeURIComponent(gateId), { method: 'PATCH', headers: { 'content-type': 'application/json', apikey: 'x' }, body: JSON.stringify({ text: COMPLIANT }) });
  const apOk = await app('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: gateId, action: 'approve' }) });
  check('with both lines back, the same post approves', apOk.ok, String(apOk.status) + ' ' + JSON.stringify(await jsonOf(apOk)));

  // The rule has to hold at every door that puts a post into Metricool, not
  // only the two the dashboard drives. A non-compliant Instagram post sitting
  // in Metricool's review queue is one this app will refuse to approve — but
  // somebody working inside Metricool could still publish it, where no gate of
  // ours can reach. So the creating routes refuse as well.
  const badTpl = await jsonOf(await app('/api/templates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'E2E compliance probe', providers: ['instagram'], weekdays: [1], time_local: '09:00', text: 'Stem cells cure everything.' }),
  }));
  const badTplId = badTpl?.template?.id;
  const putsBeforeApply = (await mc('/__requests')).filter((q) => q.method === 'POST').length;
  const applied422 = await app('/api/templates/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: badTplId, weeks: 1 }),
  });
  check('applying a non-compliant Instagram template is refused (422)',
    applied422.status === 422 && (await jsonOf(applied422))?.error === 'compliance', String(applied422.status));
  check('and not one post was created in Metricool',
    (await mc('/__requests')).filter((q) => q.method === 'POST').length === putsBeforeApply);

  // ...while a compliant template still applies.
  const okTpl = await jsonOf(await app('/api/templates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'E2E compliant template', providers: ['instagram'], weekdays: [1], time_local: '09:00', text: COMPLIANT }),
  }));
  const okApplied = await app('/api/templates/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: okTpl?.template?.id, weeks: 1 }),
  });
  check('a compliant Instagram template still applies', okApplied.ok, String(okApplied.status) + ' ' + JSON.stringify(await jsonOf(okApplied)));

  // A network the rule does not cover is unaffected by any of this.
  const liTpl = await jsonOf(await app('/api/templates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'E2E linkedin template', providers: ['linkedin'], weekdays: [1], time_local: '09:00', text: 'No advertising notice needed here.' }),
  }));
  const liApplied = await app('/api/templates/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: liTpl?.template?.id, weeks: 1 }),
  });
  check('a LinkedIn template is untouched by the advertising rule', liApplied.ok, String(liApplied.status));

  // ----------------------------------------------------- Google sources ------
  // Meriz's calendar, Rodrigo's video sheet and the image folder, read
  // through the mock Google API (e2e/mock-google.cjs) shaped like the real
  // documents; an approval is written back to the calendar sheet.
  const st = await jsonOf(await app('/api/sources?kind=status'));
  check('sources report as configured with the three document ids', st?.configured === true && st?.ids?.calendar && st?.ids?.videos && st?.ids?.images, JSON.stringify(st));
  const cal = await jsonOf(await app('/api/sources?kind=calendar&fresh=1'));
  // 'Task Delegation' has a Date column but no post text, so it is a planning
  // skeleton and must not become blank rows in "coming up".
  check('the calendar is read across its tabs, skipping the ones with no post text',
    Array.isArray(cal?.entries) && cal.entries.length === 6 && !cal.tabs.includes('Task Delegation'),
    JSON.stringify({ n: cal?.entries?.length, tabs: cal?.tabs }));
  // Meriz's real tab: month grid on the left, ID/Date/Pillar/Type/Description/
  // Owner/Status/CTA on the right. There is no Caption and no Graphics Link.
  const sep = (cal?.entries || []).find((e) => /Exosome therapy/.test(e.caption));
  check('a row from the real layout carries its date, status, owner and pillar',
    sep && sep.date && sep.status === 'For approval' && sep.owner === 'Meriz' && sep.pillar === 'Education', JSON.stringify(sep));
  // The older layout, still in the workbook, still reads — including networks.
  const legacy = (cal?.entries || []).find((e) => /body starts showing signals/.test(e.caption));
  check('and a row from the older layout still carries its graphic and networks',
    legacy && /drive\.google/.test(legacy.graphicsLink) && legacy.networks.includes('instagram') && legacy.networks.includes('facebook'), JSON.stringify(legacy));
  const vids = await jsonOf(await app('/api/sources?kind=videos&fresh=1'));
  check("Rodrigo's sheet is read with its Spanish headers", Array.isArray(vids?.entries) && vids.entries.length === 2, JSON.stringify(vids?.entries?.length));
  const iv = (vids?.entries || []).find((v) => /IV Therapy/.test(v.title));
  check('a video carries creator, title, copy, link and format',
    iv && iv.creator === 'Milán' && iv.title === 'IV Therapy' &&
    /structured clinical environment/.test(iv.copy) &&
    /drive\.google/.test(iv.videoLink) && iv.format === 'Vertical 9:16', JSON.stringify(iv));
  // The flags in this sheet are Google checkboxes, so a column reads TRUE or
  // FALSE — never blank. Counting any non-empty cell as a yes listed a video
  // as going everywhere its sheet says it does NOT.
  check('and only the networks the sheet says TRUE for',
    iv && ['youtube', 'tiktok', 'facebook', 'instagram'].every((n) => iv.networks.includes(n)) &&
    !iv.networks.includes('linkedin') && !iv.networks.includes('twitter') && !iv.networks.includes('email'),
    JSON.stringify(iv?.networks));
  const jrn = (vids?.entries || []).find((v) => /Journey Begins/.test(v.title));
  check('a YouTube-only video is not also listed as LinkedIn and Email',
    jrn && jrn.networks.length === 1 && jrn.networks[0] === 'youtube', JSON.stringify(jrn?.networks));
  check('and its OBSERVACIÓN stays a note, not a network',
    jrn && jrn.notes === 'Unlisted', JSON.stringify({ notes: jrn?.notes }));
  // Google refuses in several very different ways and each needs a different
  // person to do a different thing. The dashboard used to answer every one of
  // them with "share it with the service account", which on these documents —
  // already shared with anyone-who-has-the-link — was the one thing that was
  // not wrong.
  const GOOGLE_REFUSALS = [
    ['the Sheets API was never switched on', 403,
      { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Sheets API has not been used in project 504518 before or it is disabled.' } },
      'api_disabled', /not switched on for this project/i],
    ['the document really is not shared', 403,
      { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
      'not_shared', /press Share, and add that address/i],
    ['the key does not carry the right scopes', 403,
      { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } },
      'bad_scopes', /re-issue the service-account key/i],
    ['the id points at nothing', 404,
      { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' } },
      'not_found', /no document with the id/i],
  ];
  for (const [name, status, body, reason, advice] of GOOGLE_REFUSALS) {
    await fetch(GO + '/__refuse', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, body: JSON.stringify(body) }) });
    const r = await jsonOf(await app('/api/sources?kind=calendar&fresh=1'));
    check('Google refusal — ' + name + ' — is named as itself', r?.error === reason, JSON.stringify(r?.error));
    check('  and the advice is the action that would actually fix it', advice.test(r?.message || ''), String(r?.message).slice(0, 140));
    check('  and Google\'s own sentence is quoted, not swallowed',
      /Google said/.test(r?.message || '') && r.message.includes(body.error.message.slice(0, 30)), String(r?.message).slice(-140));
  }
  await fetch(GO + '/__refuse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: null }) });
  const calAfterRefusals = await jsonOf(await app('/api/sources?kind=calendar&fresh=1'));
  check('and the calendar reads again once Google stops refusing', Array.isArray(calAfterRefusals?.entries), JSON.stringify(calAfterRefusals?.error));

  // ---- editing the sheets from the dashboard --------------------------------
  // Google will not let its editor be framed, so "edit live" means these
  // writes: what the dashboard saves has to land in the real file.
  const calBefore = await jsonOf(await app('/api/sources?kind=calendar&fresh=1'));
  const calRow = (calBefore?.entries || []).find((e) => /Exosome therapy/.test(e.caption));
  check('a calendar row knows the tab and row it came from', Boolean(calRow && calRow.tab && calRow.row >= 2), JSON.stringify(calRow && { tab: calRow.tab, row: calRow.row }));
  check('and which A1 column each editable field lives in',
    Boolean(calRow?.columns?.description && calRow.columns.status), JSON.stringify(calRow?.columns));

  const edited = await app('/api/sources', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'calendar', tab: calRow.tab, row: calRow.row,
      changes: { description: 'Exosome therapy, rewritten from the dashboard.', status: 'Ready' },
      expected: { description: calRow.caption, status: calRow.status } }),
  });
  check('editing a calendar row succeeds', edited.ok, String(edited.status) + ' ' + JSON.stringify(await jsonOf(edited)));
  const sheetNow = await (await fetch(GO + '/__state')).json();
  const calTab = sheetNow[st.ids.calendar].tabs.find((t) => t.title === calRow.tab);
  const writtenRow = calTab.rows[calRow.row - 1];
  check('and the words are in the sheet itself, in the right row',
    writtenRow.join('|').includes('rewritten from the dashboard'), JSON.stringify(writtenRow));
  check('and the month grid beside it was not touched',
    writtenRow.slice(0, 7).join('|') === ['', '', '', '', '', '1', '2'].join('|'), JSON.stringify(writtenRow.slice(0, 7)));
  const reread = await jsonOf(await app('/api/sources?kind=calendar&fresh=1'));
  check('and reading it back shows the new text', (reread?.entries || []).some((e) => /rewritten from the dashboard/.test(e.caption)));

  // Somebody else got there first.
  const stale = await app('/api/sources', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'calendar', tab: calRow.tab, row: calRow.row,
      changes: { description: 'A third version.' },
      expected: { description: calRow.caption } }),
  });
  const staleBody = await jsonOf(stale);
  check('a row edited in Google underneath you is refused, not overwritten',
    stale.status === 409 && staleBody?.error === 'changed_underneath', String(stale.status) + ' ' + JSON.stringify(staleBody?.error));
  check('and it says to reload rather than blaming the person', /reload/i.test(staleBody?.message || ''), staleBody?.message);
  const afterStale = await (await fetch(GO + '/__state')).json();
  check('and the sheet still holds the first edit',
    afterStale[st.ids.calendar].tabs.find((t) => t.title === calRow.tab).rows[calRow.row - 1].join('|').includes('rewritten from the dashboard'));

  // The month grid, and anything else off the allowlist, is unreachable.
  for (const field of ['sun', 'mon', 'id', 'col0']) {
    const bad = await app('/api/sources', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'calendar', tab: calRow.tab, row: calRow.row, changes: { [field]: 'X' } }),
    });
    check('"' + field + '" cannot be written through the dashboard', bad.status === 400 && (await jsonOf(bad))?.error === 'field_not_editable', String(bad.status));
  }
  const badRow = await app('/api/sources', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'calendar', tab: calRow.tab, row: 1, changes: { description: 'X' } }),
  });
  check('the header row cannot be written either', badRow.status === 400, String(badRow.status));

  // The video sheet edits the same way.
  const vidsNow = await jsonOf(await app('/api/sources?kind=videos&fresh=1'));
  const vt = (vidsNow?.entries || []).find((v) => /IV Therapy/.test(v.title));
  const vEdit = await app('/api/sources', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'videos', tab: vt.tab, row: vt.row, changes: { copy: 'IV therapy, retitled from the dashboard.' }, expected: { copy: vt.copy } }),
  });
  check('a video row edits the same way', vEdit.ok, String(vEdit.status) + ' ' + JSON.stringify(await jsonOf(vEdit)));
  const vAfter = await jsonOf(await app('/api/sources?kind=videos&fresh=1'));
  check('and the video sheet shows it back', (vAfter?.entries || []).some((v) => /retitled from the dashboard/.test(v.copy)));

  // "Type in something new": a brand new row in the sheet.
  const added = await app('/api/sources', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'add_row', kind: 'calendar', tab: calRow.tab,
      values: { description: 'A post written from the dashboard.', date: '2026-12-01', status: 'Not started', owner: 'Meriz' } }),
  });
  const addedBody = await jsonOf(added);
  check('a new row can be written into the sheet from here', added.ok && addedBody?.row > 0, String(added.status) + ' ' + JSON.stringify(addedBody));
  const stateAfterAdd = await (await fetch(GO + '/__state')).json();
  const addedRow = stateAfterAdd[st.ids.calendar].tabs.find((t) => t.title === calRow.tab).rows[addedBody.row - 1];
  check('and it lands in the task-table columns, not the month grid',
    addedRow.join('|').includes('A post written from the dashboard') && addedRow.slice(0, 7).every((c) => !String(c || '').trim()),
    JSON.stringify(addedRow));
  const afterAdd = await jsonOf(await app('/api/sources?kind=calendar&fresh=1'));
  check('and the dashboard reads it straight back', (afterAdd?.entries || []).some((e) => /written from the dashboard/.test(e.caption)));
  const badNew = await app('/api/sources', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'add_row', kind: 'calendar', tab: calRow.tab, values: { sun: 'X' } }),
  });
  check('a new row cannot write outside the allowed fields either', badNew.status === 400 && (await jsonOf(badNew))?.error === 'field_not_editable', String(badNew.status));

  // Adding a photo to the shared folder.
  const oneByOne = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await app('/api/sources', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'upload_image', name: 'clinic-room.png', contentType: 'image/png', data: oneByOne }),
  });
  const upBody = await jsonOf(up);
  check('a photo can be added to the team\'s Drive folder from here', up.ok && Boolean(upBody?.image?.id), String(up.status) + ' ' + JSON.stringify(upBody));
  const afterUpload = await jsonOf(await app('/api/sources?kind=images&fresh=1'));
  check('and it appears in the gallery straight away', (afterUpload?.images || []).some((i) => i.name === 'clinic-room.png'), JSON.stringify((afterUpload?.images || []).map((i) => i.name)));
  const badType = await app('/api/sources', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'upload_image', name: 'notes.pdf', contentType: 'application/pdf', data: oneByOne }),
  });
  check('and only images are accepted', badType.status === 400, String(badType.status));

  const imgs = await jsonOf(await app('/api/sources?kind=images&fresh=1'));
  check('the image folder lists its photos with thumbnails',
    Array.isArray(imgs?.images) && imgs.images.length >= 3 && imgs.images.every((i) => /drive\.google\.com\/thumbnail/.test(i.thumbUrl)), JSON.stringify(imgs?.images?.length));
  const imp = await app('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import_image', fileId: imgs.images[0].id }) });
  const impBody = await jsonOf(imp);
  check('"Use as hero image" copies the Drive photo into the app\'s own public storage', imp.ok && /^http/.test(impBody?.url || '') && !/drive\.google/.test(impBody?.url || ''), String(imp.status) + ' ' + JSON.stringify(impBody));
  const badImp = await app('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import_image', fileId: '../../etc/passwd' }) });
  check('an invalid file id is refused', badImp.status === 400, String(badImp.status));

  // Write-back: the approvals above landed on the calendar sheet's own tab.
  await new Promise((r) => setTimeout(r, 300));
  const gstate = await (await fetch(G + '/__state')).json();
  const calDoc = gstate[st.ids.calendar];
  const approvalsTab = (calDoc?.tabs || []).find((t) => t.title === 'Dashboard Approvals');
  check('approving on the dashboard wrote a row to the calendar sheet, on its own "Dashboard Approvals" tab', Boolean(approvalsTab) && approvalsTab.rows.length >= 2, JSON.stringify(approvalsTab?.rows?.length));
  check('with a header row and the caption, networks and post id', approvalsTab && approvalsTab.rows[0][0] === 'Approved at' && approvalsTab.rows.some((r) => r[2] === 'facebook' && /Real clinic tip/.test(r[3]) && r[6] === gateId), JSON.stringify(approvalsTab?.rows?.slice(0, 3)));
  check('and the month tabs Meriz laid out were not touched', calDoc.tabs.find((t) => t.title === 'September Content').rows.length === 3);

  await fetch(G + '/__unshare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: st.ids.videos }) });
  const unshared = await app('/api/sources?kind=videos&fresh=1');
  const unsharedBody = await jsonOf(unshared);
  check('a document not shared with the service account says so, and says to Share it',
    unshared.status === 502 && unsharedBody?.error === 'not_shared' && /press Share/i.test(unsharedBody?.message || ''), JSON.stringify(unsharedBody));
  // The address to share WITH only exists when a service-account key is
  // configured; this harness authenticates with a static token, so the field
  // is carried separately rather than glued into the sentence — the dashboard
  // reads it from there and shows it when it has one.
  check('and it carries the service-account field for the UI to name',
    'serviceAccount' in (unsharedBody || {}), JSON.stringify(Object.keys(unsharedBody || {})));
  await fetch(G + '/__reset', { method: 'POST' });

  // ------------------------------------------------- Video Library → Prepare
  // A YouTube link becomes a LinkedIn post + TikTok caption from the video's
  // own captions (mock YouTube), through the keyword brief (mock Semrush) and
  // the writer (mock Anthropic), cited (mock Crossref) and stamped with AVISO.
  const prep = (b) => app('/api/videos/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const badUrl = await prep({ url: 'https://vimeo.com/12345' });
  check('a non-YouTube link is refused (400)', badUrl.status === 400 && (await jsonOf(badUrl))?.error === 'invalid_url', String(badUrl.status));
  const noCap = await prep({ url: 'https://www.youtube.com/watch?v=nocap000001' });
  const noCapBody = await jsonOf(noCap);
  check('a video without captions asks for a pasted transcript (422), naming the video', noCap.status === 422 && noCapBody?.error === 'no_transcript' && noCapBody?.reason === 'no_captions' && /without captions/.test(noCapBody?.title || ''), String(noCap.status) + ' ' + JSON.stringify(noCapBody));
  const goneVid = await prep({ url: 'https://youtu.be/gone0000001' });
  check('a video YouTube does not know is reported as unavailable, not as a crash', goneVid.status === 422 && (await jsonOf(goneVid))?.reason === 'unavailable', String(goneVid.status));
  const shortT = await prep({ url: 'https://www.youtube.com/watch?v=nocap000001', transcript: 'too short' });
  check('a pasted transcript that is too short is refused', shortT.status === 422 && (await jsonOf(shortT))?.error === 'transcript_too_short', String(shortT.status));
  const draftsBefore = ((await (await fetch(SB + '/rest/v1/drafts?select=id', { headers: { apikey: 'x' } })).json()) || []).length;
  const ok = await prep({ url: 'https://www.youtube.com/watch?v=capt0000001' });
  const okBody = await jsonOf(ok);
  check('a captioned video is transcribed from YouTube and written up', ok.ok && okBody?.ok === true && okBody.transcript?.source === 'youtube' && okBody.transcript?.language === 'en' && okBody.transcript?.chars > 100, String(ok.status) + ' ' + JSON.stringify(okBody).slice(0, 300));
  check("the title comes from YouTube's own page", /knee pain/i.test(okBody?.title || ''), JSON.stringify(okBody?.title));
  check('the LinkedIn post is written from the transcript and ends with the video link', /twelve months|knee/i.test(okBody?.linkedin || '') && /Watch: https:\/\/www\.youtube\.com\/watch\?v=capt0000001$/.test(okBody?.linkedin || ''), JSON.stringify(okBody?.linkedin));
  check('the TikTok caption carries the REF citation and the AVISO line', /REF: .*DOI: 10\.3390/.test(okBody?.tiktok || '') && /AVISO DE PUBLICIDAD: \d/.test(okBody?.tiktok || ''), JSON.stringify(okBody?.tiktok));
  check('the citation was verified against Crossref', okBody?.compliance?.citation?.status === 'verified', JSON.stringify(okBody?.compliance?.citation));
  check('the keyword brief ran over Semrush', okBody?.keywords?.checked === true && okBody.keywords.source === 'semrush' && okBody.keywords.primary, JSON.stringify(okBody?.keywords).slice(0, 200));
  const draftsAfter = (await (await fetch(SB + '/rest/v1/drafts?select=id,topic,channels,pack', { headers: { apikey: 'x' } })).json()) || [];
  const vDraft = draftsAfter.find((d) => d.id === okBody?.draftId);
  check('and it was saved as a video draft for LinkedIn + TikTok', draftsAfter.length === draftsBefore + 1 && vDraft && vDraft.pack?.kind === 'video' && vDraft.pack?.videoId === 'capt0000001' && /^Video · /.test(vDraft.topic) && vDraft.channels.includes('tiktok'), JSON.stringify({ before: draftsBefore, after: draftsAfter.length, topic: vDraft?.topic }));
  const autoCap = await prep({ url: 'https://www.youtube.com/watch?v=auto0000001' });
  const autoBody = await jsonOf(autoCap);
  check('an auto-generated Spanish track is used when it is all there is', autoCap.ok && autoBody?.transcript?.language === 'es', String(autoCap.status) + ' ' + JSON.stringify(autoBody?.transcript));
  const pasted = await prep({ url: 'https://www.youtube.com/watch?v=nocap000001', title: 'Pasted talk', transcript: 'In this talk we explain how the clinic evaluates every patient before any cell therapy is considered, and what the published studies say about safety.' });
  const pastedBody = await jsonOf(pasted);
  check('a pasted transcript is accepted for a video without captions', pasted.ok && pastedBody?.transcript?.source === 'pasted' && pastedBody?.title === 'Pasted talk', String(pasted.status) + ' ' + JSON.stringify(pastedBody?.transcript));
  // Send to Metricool for review — the same door the composer uses.
  const sendLi = await app('/api/metricool/schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'linkedin', text: okBody.linkedin, publishAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16), draftId: okBody.draftId }) });
  check('the LinkedIn copy goes to Metricool for review (draft, never auto-published)', sendLi.ok, String(sendLi.status) + ' ' + JSON.stringify(await jsonOf(sendLi)).slice(0, 200));

  // ------------------------------------------------ Brand Brain: visual identity
  // The palette and photography direction are data the image pipeline reads.
  // A bad colour is dropped and the guide's palette stands in; a good one is kept.
  const brandBefore = await jsonOf(await app('/api/brand'));
  const visualSave = await app('/api/brand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(brandBefore?.brand || {}), visual: { palette: [{ name: 'Ink', hex: '#101010' }, { name: 'Sand', hex: '#F1E7D0' }, { name: 'bad', hex: 'red' }], materials: 'walnut and cream', never: ['blue light'] } }) });
  const visualSaved = await jsonOf(visualSave);
  check('Brand Brain stores a visual identity, normalized (bad colours dropped, roles inferred)', visualSave.ok && visualSaved?.brand?.visual?.palette?.length === 2 && visualSaved.brand.visual.palette[0].role === 'dark' && visualSaved.brand.visual.palette[1].role === 'light' && visualSaved.brand.visual.materials === 'walnut and cream', String(visualSave.status) + ' ' + JSON.stringify(visualSaved?.brand?.visual).slice(0, 200));
  const visualBack = await jsonOf(await app('/api/brand'));
  check('and reads it back', visualBack?.brand?.visual?.palette?.[0]?.hex === '#101010', JSON.stringify(visualBack?.brand?.visual?.palette));
  // Restore the guide palette so the cards below are painted in it.
  await app('/api/brand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(brandBefore?.brand || {}), visual: {} }) });

  // ------------------------------------------------------- Brand cards
  // The gallery's typographic slides, painted from the draft's own words in
  // the brand palette and marks; the AI draws nothing here. The route stores
  // real PNGs and records them on the draft.
  const card = (b) => app('/api/drafts/card', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  check('a card request without a draft id is refused (400)', (await card({})).status === 400);
  check('a card for a draft that is not yours is not found (404)', (await card({ id: 'someone-elses-draft' })).status === 404);
  const carousel = await card({ id: 'draft-1', ground: 'paper' });
  const carouselBody = await jsonOf(carousel);
  const cs = carouselBody?.cards?.slides || [];
  check('a carousel is one card per idea in the caption: the topic cover plus the caption line — never the REF, AVISO or hashtag lines', carousel.ok && cs.length === 2 && cs[0].headline === 'Exosome therapy for joint recovery' && /changing recovery timelines/.test(cs[1].headline) && !JSON.stringify(cs).includes('REF:') && !JSON.stringify(cs).includes('AVISO'), String(carousel.status) + ' ' + JSON.stringify(cs).slice(0, 300));
  check('cards are 1080×1350 PNGs stored under a URL, the cover on the strong colour and the rest on paper', cs.length === 2 && cs.every((c) => c.width === 1080 && c.height === 1350 && /^https?:/.test(c.url)) && cs[0].ground === 'rust' && cs[1].ground === 'paper', JSON.stringify(cs.map((c) => [c.ground, c.width, c.height])));
  check('without licensed brand fonts the set is marked stand-in type', carouselBody?.cards?.standIn === true, JSON.stringify(carouselBody?.cards?.standIn));
  const afterCards = await jsonOf(await app('/api/drafts?limit=50'));
  const d1 = (Array.isArray(afterCards?.drafts) ? afterCards.drafts : Array.isArray(afterCards) ? afterCards : []).find((d) => d.id === 'draft-1');
  check('the carousel is recorded on the draft as pack._cards', d1?.pack?._cards?.slides?.length === 2, JSON.stringify(Object.keys(d1?.pack || {})));
  const flaggedPhoto = await card({ id: 'draft-2', ground: 'photo' });
  const flaggedBody = await jsonOf(flaggedPhoto);
  check('a photo cover refuses a text-flagged hero image and falls back to the brand colour, saying so', flaggedPhoto.ok && flaggedBody?.cards?.ground === 'rust' && /No verified hero image/.test(flaggedBody?.note || ''), String(flaggedPhoto.status) + ' ' + JSON.stringify({ ground: flaggedBody?.cards?.ground, note: flaggedBody?.note }));
  const heroCard = await card({ id: 'draft-1', ground: 'photo', size: 'square', setHero: true, slides: [{ kicker: 'Basic cell biology', headline: 'What is a stem cell?', body: 'It self-renews and differentiates.' }] });
  const heroBody = await jsonOf(heroCard);
  check('a photo cover uses the verified hero image, is square when asked, and can become the post image', heroCard.ok && heroBody?.cards?.ground === 'photo' && heroBody.cards.slides?.[0]?.ground === 'photo' && heroBody.cards.slides[0].width === 1080 && heroBody.cards.slides[0].height === 1080 && heroBody?.hero?.source === 'brand-card' && heroBody.hero.verification?.status === 'approved', String(heroCard.status) + ' ' + JSON.stringify({ g: heroBody?.cards?.ground, hero: heroBody?.hero?.source }));
  const afterHero = await jsonOf(await app('/api/drafts?limit=50'));
  const d1b = (Array.isArray(afterHero?.drafts) ? afterHero.drafts : Array.isArray(afterHero) ? afterHero : []).find((d) => d.id === 'draft-1');
  check('the draft now carries the card as its image, marked as a brand card', d1b?.pack?._image?.source === 'brand-card' && /^https?:/.test(d1b?.pack?._image?.url || ''), JSON.stringify(d1b?.pack?._image?.source));

  // ------------------------------------------------ Brand typeface files
  // Licensed fonts are uploaded from Brand Brain into private storage (never the
  // repo). Trial builds are refused with the reason; a licensed Rische is stored,
  // listed, and becomes the body face of the next card; removing it undoes that.
  const fontBytes = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'fonts', 'standin', 'Outfit-Regular.ttf'));
  const fontForm = (name) => { const fd = new FormData(); fd.append('files', new Blob([fontBytes], { type: 'font/otf' }), name); return fd; };
  const fontsBefore = await jsonOf(await app('/api/brand/fonts'));
  check('the font store lists what is uploaded and which faces still run on a stand-in', Array.isArray(fontsBefore?.fonts) && Array.isArray(fontsBefore?.standInFaces) && fontsBefore.standInFaces.includes('headline'), JSON.stringify(fontsBefore));
  const trialUp = await app('/api/brand/fonts', { method: 'POST', body: fontForm('Nexa-Trial-Bold.otf') });
  const trialBody = await jsonOf(trialUp);
  check('a trial/demo font upload is refused (422) and told why', trialUp.status === 422 && trialBody?.refused?.[0] && /trial\/demo/.test(trialBody.refused[0].reason) && (trialBody.saved || []).length === 0, String(trialUp.status) + ' ' + JSON.stringify(trialBody?.refused));
  const junkUp = await app('/api/brand/fonts', { method: 'POST', body: fontForm('Comic.ttf') });
  check('a font that is not one of the brand faces is refused', junkUp.status === 422 && /Canela, Nexa, Rische/.test(JSON.stringify(await jsonOf(junkUp))), String(junkUp.status));
  const noFiles = await app('/api/brand/fonts', { method: 'POST', body: new FormData() });
  check('an upload with no files is a 400', noFiles.status === 400, String(noFiles.status));
  const rischeUp = await app('/api/brand/fonts', { method: 'POST', body: fontForm('Rische-Regular.otf') });
  const rischeBody = await jsonOf(rischeUp);
  check('a licensed Rische file is stored and becomes the body face; the headline still needs Canela', rischeUp.ok && rischeBody?.saved?.includes('Rische-Regular.otf') && rischeBody.body === 'Rische' && rischeBody.headline === null && JSON.stringify(rischeBody.standInFaces) === JSON.stringify(['headline']), String(rischeUp.status) + ' ' + JSON.stringify({ saved: rischeBody?.saved, body: rischeBody?.body, faces: rischeBody?.standInFaces }));
  const fontsAfter = await jsonOf(await app('/api/brand/fonts'));
  check('and it is listed with its family, role and weight', fontsAfter?.fonts?.some((f) => f.name === 'Rische-Regular.otf' && f.file?.family === 'Rische' && f.file?.role === 'body' && f.file?.weight === 400), JSON.stringify(fontsAfter?.fonts));
  const cardWithRische = await jsonOf(await card({ id: 'draft-1', ground: 'pearl', slides: [{ headline: 'Set in Rische' }] }));
  check('the next card is drawn with the uploaded body face — only the headline is still a stand-in', cardWithRische?.cards?.standIn === true && JSON.stringify(cardWithRische.cards.standInFaces) === JSON.stringify(['headline']), JSON.stringify(cardWithRische?.cards?.standInFaces));
  const badDel = await app('/api/brand/fonts?name=../secrets.txt', { method: 'DELETE' });
  check('removing something that is not a font file is refused', badDel.status === 400, String(badDel.status));
  const fontDel = await jsonOf(await app('/api/brand/fonts?name=Rische-Regular.otf', { method: 'DELETE' }));
  check('removing the file puts the body back on the stand-in', fontDel?.ok === true && fontDel.body === null && !(fontDel.fonts || []).some((f) => f.name === 'Rische-Regular.otf'), JSON.stringify({ body: fontDel?.body, fonts: fontDel?.fonts?.map((f) => f.name) }));

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

  // ------------------------------------------ keyword research over MCP -----
  // The account's key is a v4 (Pro-plan) token, which the Standard API v3
  // endpoints refuse. lib/semrush-transport routes such a key through
  // Semrush's MCP server instead. The mock MCP validates parameter NAMES like
  // the real one, so this proves the translation, the session handshake, the
  // v3 CSV parsing, the cache, the spend log and the health signal, end to end.
  const MCP = 'http://127.0.0.1:54323';
  const mcpCalls = async () => (await fetch(MCP + '/__calls')).json();
  await fetch(MCP + '/__reset', { method: 'POST' });
  await fetch(SB + '/__reseed', { method: 'POST' });

  const healthSem = ((await jsonOf(await app('/api/health')))?.checks || []).find((c) => c.name === 'semrush') || {};
  check('health reports live keyword research over the MCP server for a v4 key',
    healthSem.ok === true && /MCP/.test(healthSem.detail || ''), JSON.stringify(healthSem));

  const topic = 'exosome therapy for knees';
  const brief1 = await jsonOf(await app('/api/semrush?topic=' + encodeURIComponent(topic)));
  check('a keyword brief is researched live through MCP', brief1?.ok === true && brief1.source === 'semrush' && brief1.fromCache === false, JSON.stringify(brief1).slice(0, 300));
  check('and it carries a primary keyword with real volume', Boolean(brief1?.brief?.primary?.keyword) && brief1.brief.primary.volume > 0, JSON.stringify(brief1?.brief?.primary));
  check('and searcher questions', Array.isArray(brief1?.questions) && brief1.questions.length > 0);
  const calls1 = await mcpCalls();
  const reports1 = calls1.map((c) => c.report).sort();
  check('MCP received the related + questions reports', reports1.includes('phrase_related') && reports1.includes('phrase_questions'), reports1.join(','));
  check('with MCP column names, never v3 codes',
    calls1.every((c) => Array.isArray(c.params.export_columns) && c.params.export_columns.every((col) => /^[a-z_]+$/.test(col))), JSON.stringify(calls1[0]?.params));
  check('and the key never travels inside the parameters', !JSON.stringify(calls1).includes('semrtkn'));
  check('on one session, not a handshake per call', new Set(calls1.map((c) => c.session)).size === 1);

  const brief2 = await jsonOf(await app('/api/semrush?topic=' + encodeURIComponent(topic)));
  const calls2 = await mcpCalls();
  check('the same topic again is served from cache and spends nothing', brief2?.fromCache === true && brief2.unitsSpent === 0 && calls2.length === calls1.length, JSON.stringify({ fromCache: brief2?.fromCache, calls: calls2.length }));

  const spendRows = await (await fetch(SB + '/rest/v1/semrush_usage?source=eq.live&select=units', { headers: { apikey: 'x', authorization: 'Bearer x' } })).json();
  const spent = (Array.isArray(spendRows) ? spendRows : []).reduce((a, r) => a + (Number(r.units) || 0), 0);
  check('every live MCP spend is logged as units', spent > 0, JSON.stringify(spendRows));
  const bal = await jsonOf(await app('/api/semrush?action=balance&fresh=1'));
  check('and a fresh balance read is the monthly allowance minus the logged spend', bal?.balance === 50000 - spent, JSON.stringify({ balance: bal?.balance, spent }));

  // The spend log read must never under-count: PostgREST caps a page at the
  // project's max-rows while the exact count still says how many there are.
  await fetch(SB + '/__maxrows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 1 }) });
  const capped = await jsonOf(await app('/api/semrush?action=balance&fresh=1'));
  check('a capped spend-log page reads as "balance unknown", never as a higher balance', capped?.balance === null, JSON.stringify(capped));
  const healthCapped = ((await jsonOf(await app('/api/health')))?.checks || []).find((c) => c.name === 'semrush') || {};
  check('and the guard fails closed while it lasts', healthCapped.ok === false && healthCapped.code === 'balance_unknown', JSON.stringify(healthCapped));
  await fetch(SB + '/__maxrows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: null }) });
  const uncapped = await jsonOf(await app('/api/semrush?action=balance&fresh=1'));
  check('and recovers on the next full read', uncapped?.balance === 50000 - spent, JSON.stringify(uncapped));

  const dom = await jsonOf(await app('/api/semrush?action=domain'));
  check('the domain panel loads live over MCP: overview', dom?.overview?.rank === 1209589 && dom.overviewMeta?.source === 'live', JSON.stringify(dom?.overviewMeta));
  check('  backlinks', dom?.backlinks?.authorityScore === 11, JSON.stringify(dom?.backlinks));
  check('  top keywords (v3 domain_organic → MCP resource_organic)', Array.isArray(dom?.topKeywords) && dom.topKeywords.length === 2 && dom.topKeywords[0].position === 1, JSON.stringify(dom?.topKeywordsMeta));
  check('  competitors', Array.isArray(dom?.competitors) && dom.competitors[0]?.domain === 'bookimed.com', JSON.stringify(dom?.competitorsMeta));
  check('and the panel badge is told research is active over mcp', dom?.keywordResearch?.ok === true && dom.keywordResearch.transport === 'mcp', JSON.stringify(dom?.keywordResearch));

  const nothing = await jsonOf(await app('/api/semrush?topic=' + encodeURIComponent('zxqv nothing here')));
  check('"nothing found" from MCP is an empty brief, not an error', nothing?.ok === false && nothing.source === 'none' && nothing.reason !== 'http' && nothing.reason !== 'network', JSON.stringify({ ok: nothing?.ok, reason: nothing?.reason, note: nothing?.note }));

  await fetch(MCP + '/__fail', { method: 'POST', body: JSON.stringify({ report: 'phrase_related' }) });
  const broken = await jsonOf(await app('/api/semrush?topic=' + encodeURIComponent('prp vs stem cells')));
  check('an MCP failure degrades to "no live data" and never a crash', broken?.ok === false && broken.source === 'none', JSON.stringify({ ok: broken?.ok, reason: broken?.reason, note: broken?.note }));
  await fetch(MCP + '/__reset', { method: 'POST' });

  console.log('\n' + (failed === 0 ? 'all' : String(failed) + ' FAILED of') + ' API e2e checks');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

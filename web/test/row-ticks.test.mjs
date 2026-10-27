// A box ticked AFTER the row was prepared, end to end: lib/video-ticks.ts
// addTickedNetworks runs for real, through the real hand-off, with the sheet,
// the database, the model and Metricool stood in for
// (test/row-ticks-module-hooks.mjs). This is what /api/videos/row does when
// the sheet's edit trigger calls it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.VIDEO_POST_DAYS = 'all';

const { addTickedNetworks } = await import('../lib/video-ticks.ts');
const { rowKeyFor } = await import('../lib/video-row.ts');
const sheet = await import('@/lib/google-sources');
const db = await import('@/lib/supabase-admin');
const register = await import('@/lib/video-register');
const publish = await import('@/lib/video-publish');
const ai = await import('@/lib/ai');

const AVISO = 'AVISO DE PUBLICIDAD: 2623022002A00090';
const REF = 'REF: Smith J, et al. J Transl Med. 2021. doi:10.1186/s12967-021-02896-5';
const LINKEDIN = ['What can one bag of removed plasma reveal?', 'Therapeutic Plasma Exchange focuses on what is removed from the bloodstream. The medical team reviews each patient’s markers before anything is decided.', REF, AVISO].join('\n\n');
const TIKTOK = ['What can one bag of removed plasma reveal? TPE focuses on what is removed.', REF, AVISO, '#tpe #plasmaexchange'].join('\n\n');
const LINK = 'https://drive.google.com/file/d/1y0C2aDO7ftDdNe9R1AG6VAmRbLk0TcWD/view';
const TITLE = 'Reel_#3TPE.mp4';
const HEADER = ['TIPO DE VIDEO', 'TÍTULO DEL VIDEO', 'LINK VIDEO', 'FORMATO', 'COPY', 'YOUTUBE', 'LINKEDIN', 'TIKTOK', 'X', 'FACEBOOK', 'INSTAGRAM', 'EMAIL'];
const NET_COL = { youtube: 5, linkedin: 6, tiktok: 7, x: 8, facebook: 9, instagram: 10, email: 11 };

/** The tab: a title row, the header on row 2, the video on row 3. */
function tab(ticks, extra = {}) {
  const r = ['Reel', TITLE, extra.link ?? LINK, extra.formato ?? 'Vertical 9:16', '', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'FALSE'];
  for (const t of ticks) r[NET_COL[t]] = 'TRUE';
  return [['Distribución RRSS', '', ''], HEADER, r];
}
const ROW = 3;
const sent = (network) => ({ network, ok: true, metricoolPostId: 'old-' + network, recorded: true });
const run = (metricool, over = {}) => ({ id: 'run-1', spreadsheet_id: 'sheet-1', tab: 'Videos', row_key: rowKeyFor(TITLE, LINK), state: 'prepared', draft_id: 'draft-1', metricool, ...over });
const draft = (pack = {}) => ({ id: 'draft-1', pack: { linkedin: LINKEDIN, tiktok: TIKTOK, title: 'What one bag of plasma reveals', ...pack } });

const click = () => addTickedNetworks({ userId: 'u1', tab: 'Videos', row: ROW });
const sentNetworks = () => publish.__sent().map((p) => p.network).sort();

beforeEach(() => {
  publish.__reset(); ai.__reset(); register.__reset();
  ai.__answers({
    facebook: 'Ever wondered what one bag of removed plasma can show? The team reviews each patient’s markers first.\n\nCurious? Ask us.',
    twitter: 'One bag of removed plasma shows what the blood was carrying.',
    youtube: 'What one bag of removed plasma reveals\n\nThe team explains what plasma exchange removes.\n\n#tpe',
  });
});

test('ticking Facebook on a row that went to the default three adds Facebook, and only Facebook', async () => {
  sheet.__sheet(tab(['youtube', 'linkedin', 'tiktok', 'facebook']));
  db.__db({ runs: [run([sent('youtube'), sent('linkedin'), sent('tiktok')])], drafts: [draft()] });
  const out = await click();
  assert.equal(out.action, 'added');
  assert.deepEqual(out.networks, ['facebook']);
  assert.deepEqual(out.sent, ['facebook']);
  assert.deepEqual(sentNetworks(), ['facebook']);
  // Written for Facebook, from the caption, with the verified REF and one AVISO.
  const fb = publish.__sent()[0].text;
  assert.match(fb, /^Ever wondered/);
  assert.match(fb, /REF: Smith J/);
  assert.equal((fb.match(/AVISO DE PUBLICIDAD/g) || []).length, 1);
  assert.deepEqual(ai.__asked().map((a) => a.network), ['facebook']);
  // The row's record now carries four answers; the three old ones untouched.
  const rec = db.__runs()[0].metricool;
  assert.deepEqual(rec.map((m) => m.network), ['youtube', 'linkedin', 'tiktok', 'facebook']);
  assert.equal(rec[0].metricoolPostId, 'old-youtube');
  assert.equal(rec[3].ok, true);
  // And the register says a tick in the sheet did it.
  const ev = register.__events();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, 'queued');
  assert.equal(ev[0].actor, 'sheet');
  assert.deepEqual(ev[0].detail.networks, ['facebook']);
  assert.equal(ev[0].detail.row, ROW);
});

test('a second tick a moment later adds only the new network: the first is already recorded', async () => {
  sheet.__sheet(tab(['youtube', 'linkedin', 'tiktok', 'facebook']));
  db.__db({ runs: [run([sent('youtube'), sent('linkedin'), sent('tiktok')])], drafts: [draft()] });
  await click();
  publish.__reset(); ai.__reset();
  sheet.__sheet(tab(['youtube', 'linkedin', 'tiktok', 'facebook', 'x']));
  const out = await click();
  assert.equal(out.action, 'added');
  assert.deepEqual(out.networks, ['twitter']);
  assert.deepEqual(sentNetworks(), ['twitter']);
  assert.deepEqual(db.__runs()[0].metricool.map((m) => m.network), ['youtube', 'linkedin', 'tiktok', 'facebook', 'twitter']);
});

test('ticking a box the row already has is nothing new, and nothing is sent', async () => {
  sheet.__sheet(tab(['youtube', 'linkedin', 'tiktok']));
  db.__db({ runs: [run([sent('youtube'), sent('linkedin'), sent('tiktok')])], drafts: [draft()] });
  const out = await click();
  assert.equal(out.action, 'nothing_new');
  assert.deepEqual(out.have, ['youtube', 'linkedin', 'tiktok']);
  assert.deepEqual(sentNetworks(), []);
  assert.equal(register.__events().length, 0);
});

test('a network the record says Metricool already holds is answered, not sent twice', async () => {
  // The hand-off answered already_queued last time (a draft made by hand on
  // the dashboard, say); that answer counts as done, so a tick adds nothing.
  sheet.__sheet(tab(['linkedin', 'facebook']));
  db.__db({ runs: [run([sent('linkedin'), { network: 'facebook', ok: false, reason: 'already_queued' }])], drafts: [draft()] });
  const out = await click();
  assert.equal(out.action, 'nothing_new');
  assert.deepEqual(sentNetworks(), []);
});

test('copy written for the network on an earlier pass is reused, not written again', async () => {
  sheet.__sheet(tab(['linkedin', 'facebook']));
  db.__db({ runs: [run([sent('linkedin')])], drafts: [draft({ tailored: { facebook: 'Facebook text from last time\n\n' + REF + '\n\n' + AVISO } })] });
  const out = await click();
  assert.equal(out.action, 'added');
  assert.deepEqual(ai.__asked(), [], 'no model call');
  assert.match(publish.__sent()[0].text, /^Facebook text from last time/);
});

test('a row that has not been prepared yet is left to the sweep', async () => {
  sheet.__sheet(tab(['youtube', 'facebook']));
  db.__db({ runs: [], drafts: [] });
  const out = await click();
  assert.equal(out.action, 'not_prepared');
  assert.equal(out.state, null);
  assert.deepEqual(sentNetworks(), []);
  db.__db({ runs: [run([], { state: 'failed' })], drafts: [] });
  assert.equal((await click()).action, 'not_prepared');
});

test('nothing ticked, a hidden row, no link, and a row that is not a data row each answer plainly', async () => {
  sheet.__sheet(tab([]));
  db.__db({ runs: [run([sent('youtube')])], drafts: [draft()] });
  assert.equal((await click()).action, 'nothing_ticked');
  sheet.__sheet(tab(['facebook']), [ROW]);
  assert.equal((await click()).action, 'hidden');
  sheet.__sheet(tab(['facebook'], { link: '' }));
  assert.equal((await click()).action, 'no_link');
  sheet.__sheet(tab(['facebook']));
  assert.equal((await addTickedNetworks({ userId: 'u1', tab: 'Videos', row: 9 })).action, 'not_a_row');
  assert.deepEqual(sentNetworks(), []);
});

test('TikTok ticked on a landscape video is refused by the shape rule, and said so', async () => {
  sheet.__sheet(tab(['linkedin', 'tiktok'], { formato: 'Horizontal 16:9' }));
  db.__db({ runs: [run([sent('linkedin')])], drafts: [draft()] });
  const out = await click();
  assert.equal(out.action, 'added');
  assert.deepEqual(out.networks, ['tiktok']);
  assert.deepEqual(out.sent, []);
  assert.deepEqual(sentNetworks(), []);
});

test('a row whose copy a person wrote sends that copy when the draft has no text of its own', async () => {
  const rows = tab(['linkedin', 'instagram']);
  rows[2][4] = 'Copy a person wrote.\n\n' + REF + '\n\n' + AVISO;
  sheet.__sheet(rows);
  db.__db({ runs: [run([sent('linkedin')])], drafts: [{ id: 'draft-1', pack: {} }] });
  const out = await click();
  assert.equal(out.action, 'added');
  assert.deepEqual(out.sent, ['instagram']);
  assert.match(publish.__sent()[0].text, /^Copy a person wrote\./);
});

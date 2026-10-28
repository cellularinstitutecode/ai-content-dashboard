// The row's ticks, end to end through the REAL hand-off: a row whose boxes
// were ticked before Prepare ran gets one Metricool draft per ticked network,
// each carrying copy written for that network, and nothing for the rest.
//
// lib/video-autopilot.ts handOffToMetricool runs for real here, with the
// model, Metricool and the database stood in for (test/handoff-module-hooks.mjs).
// The ticks are read exactly the way completeRow reads them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.VIDEO_POST_DAYS = 'all';

const { handOffToMetricool } = await import('../lib/video-autopilot.ts');
const { VIDEO_NETWORK_COLUMNS, publishedNetworks, tickedNetworks } = await import('../lib/sheet-ticks.ts');
const { NETWORK_LIMITS } = await import('../lib/composer.ts');
const publish = await import('@/lib/video-publish');
const ai = await import('@/lib/ai');
const prepare = await import('@/lib/video-prepare');

const AVISO = 'AVISO DE PUBLICIDAD: 2623022002A00090';
const REF = 'REF: Smith J, et al. J Transl Med. 2021. doi:10.1186/s12967-021-02896-5';
const LINKEDIN = [
  'What can one bag of removed plasma reveal?',
  'Therapeutic Plasma Exchange, also known as TPE, is a well-established medical procedure that focuses on what is removed from the bloodstream. During the procedure, blood passes through a specialized machine that separates the plasma.',
  'The medical team reviews each patient’s history, diagnostic results, inflammatory markers and cardiometabolic markers before anything is decided.',
  REF, AVISO,
].join('\n\n');
const TIKTOK = ['What can one bag of removed plasma reveal? TPE focuses on what is removed from the bloodstream.', REF, AVISO, '#tpe #plasmaexchange #longevity'].join('\n\n');
const LINK = 'https://drive.google.com/file/d/1y0C2aDO7ftDdNe9R1AG6VAmRbLk0TcWD/view?usp=drive_link';

/** A row of the sheet, keyed the way lib/sheet-table.ts hands records to completeRow. */
function row(ticks, extra = {}) {
  const rec = { youtube: 'FALSE', linkedin: 'FALSE', tiktok: 'FALSE', x: 'FALSE', facebook: 'FALSE', instagram: 'FALSE', email: 'FALSE', formato: 'Vertical 9:16', ...extra };
  for (const t of ticks) rec[t] = 'TRUE';
  return rec;
}

async function handOff(rec) {
  const read = (col) => rec[col] || '';
  return handOffToMetricool({
    userId: 'u1',
    prepared: { linkedin: LINKEDIN, tiktok: TIKTOK, draftId: 'draft-1', title: 'What one bag of plasma reveals' },
    // Exactly what completeRow passes.
    networks: tickedNetworks(VIDEO_NETWORK_COLUMNS, read),
    videoLink: LINK,
    title: 'Reel_#3TPExRyall_Rodrigo.mp4',
    format: rec.formato,
    sheetYoutube: rec.youtube,
    published: publishedNetworks(VIDEO_NETWORK_COLUMNS, read),
    publicationDate: '2026-10-29T18:00:00.000Z',
  });
}

const sentNetworks = () => publish.__sent().map((p) => p.network).sort();
const textFor = (network) => publish.__sent().find((p) => p.network === network)?.text || '';

beforeEach(() => {
  publish.__reset();
  ai.__reset();
  prepare.__reset();
  ai.__answers({
    youtube: 'What one bag of removed plasma reveals\n\nIn this video the team explains what therapeutic plasma exchange removes from the bloodstream and what the medical team reviews first.\n\nYou will learn what is looked at before anything is decided.\n\n#tpe #plasmaexchange',
    facebook: 'Ever wondered what one bag of removed plasma can show? Therapeutic plasma exchange focuses on what is removed from the bloodstream, and the team reviews each patient’s markers first.\n\nCurious what is looked at? Ask us.\n\n#tpe',
    twitter: 'One bag of removed plasma shows what the blood was carrying. TPE focuses on what is removed.',
  });
});

test('the sheet’s commonest row — YouTube + LinkedIn + TikTok ticked — gets all three, YouTube included', async () => {
  const out = await handOff(row(['youtube', 'linkedin', 'tiktok']));
  assert.deepEqual(out.filter((o) => o.ok).map((o) => o.network).sort(), ['linkedin', 'tiktok', 'youtube']);
  assert.deepEqual(sentNetworks(), ['linkedin', 'tiktok', 'youtube']);
  // Each its own copy.
  assert.equal(textFor('linkedin'), LINKEDIN);
  assert.equal(textFor('tiktok'), TIKTOK);
  const yt = textFor('youtube');
  assert.notEqual(yt, TIKTOK, 'YouTube no longer gets the TikTok caption');
  assert.match(yt, /^What one bag of removed plasma reveals\n/, 'the description opens with the written first line');
  assert.match(yt, /REF: Smith J/, 'the verified citation is put back');
  assert.equal((yt.match(/AVISO DE PUBLICIDAD/g) || []).length, 1, 'exactly one notice');
  // The writer's tags, then the clinic's own (lib/hashtags.ts CLINIC_HASHTAGS), last.
  assert.ok(yt.trim().endsWith('#tpe #plasmaexchange #stemcellsclinicincancun #stemcellclinicinmexico #beststemcellsclinicincancun'), 'hashtags last: ' + yt.slice(-160));
  // Only YouTube was written for; LinkedIn and TikTok cost nothing.
  assert.deepEqual(ai.__asked().map((a) => a.network), ['youtube']);
  assert.equal(ai.__asked()[0].source, LINKEDIN, 'YouTube is written from the long post');
  // And kept on the draft for later passes.
  assert.deepEqual(prepare.__stamped().map((s) => Object.keys(s.tailored)), [['youtube']]);
  // The video rides on every network.
  for (const p of publish.__sent()) assert.equal(p.mediaUrl, 'https://storage.test/copy-1.mp4');
});

test('Facebook + Instagram + X ticked: those three, each written for the network, nothing for the default three', async () => {
  await handOff(row(['facebook', 'instagram', 'x']));
  assert.deepEqual(sentNetworks(), ['facebook', 'instagram', 'twitter']);
  assert.deepEqual(ai.__asked().map((a) => a.network).sort(), ['facebook', 'twitter']);
  const fb = textFor('facebook');
  assert.match(fb, /^Ever wondered/);
  assert.match(fb, /REF: Smith J/);
  assert.match(fb, /AVISO DE PUBLICIDAD: 2623022002A00090/);
  assert.equal(textFor('instagram'), TIKTOK, 'Instagram gets the short caption written for it');
  const x = textFor('twitter');
  assert.ok(x.length <= NETWORK_LIMITS.twitter, 'X fits in 280: ' + x.length);
  assert.match(x, /^One bag of removed plasma/);
  assert.match(x, /AVISO DE PUBLICIDAD: 2623022002A00090/, 'the permit line is always kept');
  assert.notEqual(x, LINKEDIN, 'X no longer gets the LinkedIn post');
});

test('nothing ticked: the default three, as before', async () => {
  await handOff(row([]));
  assert.deepEqual(sentNetworks(), ['linkedin', 'tiktok', 'youtube']);
});

test('all six ticked on a landscape video: five drafts — TikTok is kept off a vertical feed', async () => {
  const out = await handOff(row(['facebook', 'instagram', 'youtube', 'linkedin', 'tiktok', 'x'], { formato: 'Horizontal 16:9' }));
  assert.deepEqual(sentNetworks(), ['facebook', 'instagram', 'linkedin', 'twitter', 'youtube']);
  assert.equal(out.find((o) => o.network === 'tiktok'), undefined);
  assert.deepEqual(ai.__asked().map((a) => a.network).sort(), ['facebook', 'twitter', 'youtube']);
});

test('a column holding the live link is a record, not a tick: nothing ticked + YouTube already up → LinkedIn and TikTok only', async () => {
  await handOff(row([], { youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
  assert.deepEqual(sentNetworks(), ['linkedin', 'tiktok']);
});

test('when the model cannot write for a network, that network is sent what it always was and the others are unaffected', async () => {
  ai.__answers({ facebook: null, twitter: null, youtube: null });
  const out = await handOff(row(['facebook', 'x', 'linkedin']));
  assert.deepEqual(sentNetworks(), ['facebook', 'linkedin']);
  assert.equal(textFor('facebook'), TIKTOK, 'Facebook falls back to the caption');
  const x = out.find((o) => o.network === 'twitter');
  assert.equal(x.ok, false);
  assert.equal(x.reason, 'too_long', 'X falls back to the LinkedIn post, which is refused as too long — exactly as before');
  assert.equal(prepare.__stamped().length, 0, 'nothing written for a network is nothing stamped');
});

test('an adaptation that adds a health claim the source never made is not sent', async () => {
  const bare = ['Our team walks you through what the first visit looks like.', AVISO, '#clinic'].join('\n\n');
  ai.__answers({ facebook: 'This treatment cures inflammation and restores your joints. Ask us.' });
  await handOffToMetricool({
    userId: 'u1',
    prepared: { linkedin: bare, tiktok: bare, draftId: 'draft-2', title: 'The first visit' },
    networks: ['facebook'], videoLink: LINK, title: 'visit.mp4', format: 'Vertical 9:16', published: [],
    publicationDate: '2026-10-29T18:00:00.000Z',
  });
  assert.equal(textFor('facebook'), bare, 'the claim-free source is sent instead');
});

test('copy written on an earlier pass is reused, not written again', async () => {
  const read = (col) => row(['youtube', 'facebook'])[col] || '';
  await handOffToMetricool({
    userId: 'u1',
    prepared: { linkedin: LINKEDIN, tiktok: TIKTOK, draftId: 'draft-1', title: 't', tailored: { youtube: 'YouTube text from last time\n\n' + REF + '\n\n' + AVISO } },
    networks: tickedNetworks(VIDEO_NETWORK_COLUMNS, read), videoLink: LINK, title: 't', format: 'Vertical 9:16', published: [],
    publicationDate: '2026-10-29T18:00:00.000Z',
  });
  assert.deepEqual(ai.__asked().map((a) => a.network), ['facebook'], 'only Facebook is new');
  assert.match(textFor('youtube'), /^YouTube text from last time/);
});

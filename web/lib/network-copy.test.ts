// Unit tests for which copy each network is sent. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptTailored, assembleGatedPost, assembleXPost, copyForNetwork, networksToTailor, tailorPrompt, tailorSource } from './network-copy.ts';
import { NETWORK_LIMITS } from './composer.ts';

const AVISO = '2623022002A00090';
const REF = 'Smith J, et al. J Transl Med. 2021. doi:10.1186/s12967-021-02896-5';
const linkedin = 'A long, insight-led post about plasma exchange.\n\nREF: ' + REF + '\n\nAVISO DE PUBLICIDAD: ' + AVISO;
const tiktok = 'Short caption about plasma exchange.\n\nREF: ' + REF + '\n\nAVISO DE PUBLICIDAD: ' + AVISO + '\n\n#stemcells #longevity';

// The mapping the hand-off has always used, when nothing was written for the network.
test('without its own copy a network gets what it always got', () => {
  const v = { linkedin, tiktok };
  assert.equal(copyForNetwork('linkedin', v), linkedin);
  assert.equal(copyForNetwork('twitter', v), linkedin);
  assert.equal(copyForNetwork('tiktok', v), tiktok);
  assert.equal(copyForNetwork('instagram', v), tiktok);
  assert.equal(copyForNetwork('facebook', v), tiktok);
  assert.equal(copyForNetwork('youtube', v), tiktok);
});

test('copy written for a network wins over the mapping', () => {
  const v = { linkedin, tiktok, tailored: { facebook: 'FB text', youtube: 'YT text', twitter: 'X text' } };
  assert.equal(copyForNetwork('facebook', v), 'FB text');
  assert.equal(copyForNetwork('YouTube', v), 'YT text');
  assert.equal(copyForNetwork('twitter', v), 'X text');
  // An empty tailored entry is no copy at all.
  assert.equal(copyForNetwork('facebook', { linkedin, tiktok, tailored: { facebook: '  ' } }), tiktok);
});

test('only the networks going out that have no copy of their own are owed one', () => {
  assert.deepEqual(networksToTailor(['linkedin', 'tiktok']), []);
  assert.deepEqual(networksToTailor(['youtube', 'linkedin', 'tiktok']), ['youtube']);
  assert.deepEqual(networksToTailor(['facebook', 'twitter', 'youtube', 'instagram']), ['facebook', 'twitter', 'youtube']);
  assert.deepEqual(networksToTailor(['facebook', 'twitter'], { facebook: 'done' }), ['twitter']);
  assert.deepEqual(networksToTailor(['Facebook', 'facebook']), ['facebook']);
});

test('YouTube is written from the long post, the rest from the caption', () => {
  assert.equal(tailorSource('youtube', { linkedin, tiktok }), linkedin);
  assert.equal(tailorSource('facebook', { linkedin, tiktok }), tiktok);
  assert.equal(tailorSource('twitter', { linkedin, tiktok }), tiktok);
});

test('the brief names the network and carries the source', () => {
  const p = tailorPrompt('twitter', tiktok, 'What one bag of plasma reveals');
  assert.match(p, /TARGET NETWORK: X/);
  assert.match(p, /VIDEO TITLE: What one bag/);
  assert.match(p, /200 characters/);
  assert.ok(p.endsWith(tiktok.trim()));
});

test('an answer is refused when it is empty, unchanged, a refusal or far too long', () => {
  assert.equal(acceptTailored('facebook', tiktok, ''), null);
  assert.equal(acceptTailored('facebook', tiktok, tiktok), null);
  assert.equal(acceptTailored('facebook', tiktok, 'I cannot adapt this post.'), null);
  assert.equal(acceptTailored('twitter', tiktok, 'x'.repeat(601)), null);
  assert.equal(acceptTailored('facebook', tiktok, '```\nHello there\n```'), 'Hello there');
});

test('the X post fits in 280 with the permit, and keeps the citation only when that fits too', () => {
  const short = 'One bag of removed plasma shows what the blood was carrying.';
  const withRef = assembleXPost(short, REF, AVISO);
  assert.ok(withRef);
  assert.ok(withRef!.length <= NETWORK_LIMITS.twitter);
  assert.match(withRef!, /AVISO DE PUBLICIDAD: 2623022002A00090/);
  assert.match(withRef!, /REF: Smith J/);

  const longer = 'One bag of removed plasma shows what the blood was carrying — the medical team reads the inflammatory and cardiometabolic markers before anything is decided, and that assessment is what the first consultation is for.';
  const noRef = assembleXPost(longer, REF, AVISO);
  assert.ok(noRef);
  assert.ok(noRef!.length <= NETWORK_LIMITS.twitter);
  assert.match(noRef!, /AVISO DE PUBLICIDAD: 2623022002A00090/);
  assert.doesNotMatch(noRef!, /REF:/);

  assert.equal(assembleXPost('x'.repeat(300), REF, AVISO), null, 'a body that cannot fit with the permit is not sent');
  assert.equal(assembleXPost('', REF, AVISO), null);
});

test('a Facebook or YouTube post carries exactly one notice and the verified citation', () => {
  const raw = 'Adapted text.\n\nREF: some other paper the model kept\n\nAVISO DE PUBLICIDAD COFEPRIS 1234567890\n\n#one #two';
  const out = assembleGatedPost(raw, REF, AVISO)!;
  assert.equal((out.match(/AVISO DE PUBLICIDAD/g) || []).length, 1);
  assert.match(out, /AVISO DE PUBLICIDAD: 2623022002A00090/);
  assert.match(out, /REF: Smith J/);
  assert.doesNotMatch(out, /some other paper/);
  assert.ok(out.trim().endsWith('#one #two'), 'hashtags last');
  // No citation at all: the notice alone, as a claim-free post is sent.
  assert.doesNotMatch(assembleGatedPost('Adapted text.', '', AVISO)!, /REF:/);
});

// web/lib/pack-schedule.test.ts
//
// "When a post like this is done I want the options inside this panel… the
//  images it generates attached… so that when I approve it goes live just like
//  Metricool. If I approve, it separates the paragraphs, it gives images to the
//  platforms that need them, it gets everything ready and submits it."
//
// The generator wrote three posts — an Instagram caption, a Facebook post, a
// LinkedIn post, each in its own voice and length — and the only way to
// schedule any of them was to paste one into the composer. The composer sends
// THE SAME text to every network it is given, so whichever variant was pasted
// went out on all three, at the wrong length, with the wrong voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACK_NETWORKS, planFromPack, scheduleReady } from './pack-schedule.ts';
import { DEFAULT_AVISO_NUMBER } from './compliance.ts';
import { readFileSync } from 'node:fs';

const REF = 'REF: Kalluri, R., & LeBleu, V.S. (2020). The biology of exosomes. Science. DOI: 10.1126/science.aau6977';
const AVISO = 'AVISO DE PUBLICIDAD: ' + DEFAULT_AVISO_NUMBER;
const compliant = (body: string) => body + '\n\n' + REF + '\n\n' + AVISO;
const IMAGE = 'https://example.supabase.co/storage/v1/object/public/images/hero.png';

test('each network gets its OWN variant, never another network’s', () => {
  const plans = planFromPack(
    { instagram: compliant('Short caption.'), facebook: compliant('A longer Facebook post.'), linkedin: 'A LinkedIn post.' },
    { mediaUrl: IMAGE, avisoNumber: DEFAULT_AVISO_NUMBER },
  );
  assert.deepEqual(plans.map((p) => p.network), ['instagram', 'facebook', 'linkedin']);
  assert.match(plans[0].text, /Short caption\./);
  assert.match(plans[1].text, /A longer Facebook post\./);
  assert.equal(plans[2].text, 'A LinkedIn post.');
});

test('the blog is not a network', () => {
  // Every pack has one, and 400 words of article on Instagram is how a pack
  // becomes spam.
  const plans = planFromPack({ blog: 'A whole article.', instagram: compliant('Caption.') }, { mediaUrl: IMAGE });
  assert.deepEqual(plans.map((p) => p.network), ['instagram']);
  assert.ok(!PACK_NETWORKS.some((n) => String(n.key) === 'blog'));
});

test('a variant the writer did not produce is not invented', () => {
  const plans = planFromPack({ instagram: '', facebook: '   ', linkedin: 'Only this one.' }, {});
  assert.deepEqual(plans.map((p) => p.network), ['linkedin']);
});

test('Instagram is not offered as ready without a picture', () => {
  // It cannot accept a text-only post at all, which is a refusal at the network
  // rather than a preference.
  const withOut = planFromPack({ instagram: compliant('Caption.') }, { mediaUrl: '' })[0];
  assert.equal(withOut.needsMedia, true);
  assert.equal(withOut.ready, false);
  assert.match(withOut.problem, /will not take a post without an image/);

  const withImage = planFromPack({ instagram: compliant('Caption.') }, { mediaUrl: IMAGE, avisoNumber: DEFAULT_AVISO_NUMBER })[0];
  assert.equal(withImage.ready, true, withImage.problem);
});

test('the advertising rule is checked per network, on that network’s own words', () => {
  const plans = planFromPack(
    { instagram: compliant('Caption.'), facebook: 'No notice and no citation.' },
    { mediaUrl: IMAGE, avisoNumber: DEFAULT_AVISO_NUMBER },
  );
  const ig = plans.find((p) => p.network === 'instagram')!;
  const fb = plans.find((p) => p.network === 'facebook')!;
  assert.equal(ig.compliance, 'ok');
  assert.equal(fb.compliance, 'missing');
  assert.ok(fb.missing.length, 'and it says which lines are missing');
  assert.match(fb.problem, /advertising notice and a citation/);
  assert.equal(fb.ready, false, 'a medical advertisement missing its two lines is not ready');
});

test('too long for the network is caught here, not by Metricool truncating it', () => {
  // Truncation puts the AVISO and the REF — which sit at the END — off the
  // bottom of the post, which is the one failure that looks compliant.
  const long = planFromPack({ instagram: 'x'.repeat(2400) }, { mediaUrl: IMAGE })[0];
  assert.equal(long.fits, false);
  assert.match(long.problem, /Too long for Instagram by/);
});

test('nothing is sent until every chosen row is ready', () => {
  const plans = planFromPack(
    { instagram: compliant('Caption.'), facebook: 'No notice.' },
    { mediaUrl: IMAGE, avisoNumber: DEFAULT_AVISO_NUMBER },
  );
  assert.deepEqual(scheduleReady(plans, [], '2026-09-20T09:00'), { ok: false, reason: 'Pick at least one channel.' });
  assert.deepEqual(scheduleReady(plans, ['instagram'], ''), { ok: false, reason: 'Pick when it should go out.' });
  assert.equal(scheduleReady(plans, ['instagram', 'facebook'], '2026-09-20T09:00').ok, false, 'one bad row stops the send');
  assert.equal(scheduleReady(plans, ['instagram'], '2026-09-20T09:00').ok, true);
});

// --- THE PANEL EXISTS, WHERE THE POST IS ------------------------------------

test('the generator keeps the pack, not only the text it prints', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  // `output` is the FORMATTED string — one block for a person to read. Sending
  // Instagram its caption and LinkedIn its post is impossible once the two are
  // one string, which is why scheduling meant pasting one variant by hand.
  assert.match(page, /setGenPack\(pack as Record<string, unknown>\)/, 'the pack itself must be kept');
  assert.match(page, /<SchedulePack/, 'and the panel must be mounted under the output');
  assert.match(page, /imageUrl=\{genImage\?\.url \|\| null\}/, 'with the hero image it already made');
  assert.match(page, /slots=\{mSlots\}/, 'and the planner’s own next free slots');
});

test('each network is sent its own text, in its own request', () => {
  const panel = readFileSync(new URL('../components/SchedulePack.tsx', import.meta.url), 'utf8');
  assert.match(panel, /picked\.map\(async \(p\) =>/, 'one request per network');
  assert.match(panel, /text: p\.text/, 'carrying THAT network’s words');
  assert.match(panel, /'\/api\/metricool\/schedule'/, 'through the same door every other post uses');
  assert.match(panel, /mediaUrl: imageUrl/, 'with the image attached');
  // And it cannot send a row that is not ready.
  assert.match(panel, /if \(!gate\.ok \|\| busy\) return/, 'the gate is checked before anything is sent');
});

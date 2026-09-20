// web/lib/blog-wiring.test.ts
//
// The three defects that sat on the blog path, and the path itself. Source
// checks, because every one of these files imports `server-only` or `@/`
// aliases — which is a large part of why all three survived as long as they
// did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appliesTo } from './compliance.ts';
import { metricoolNetworks } from './metricool-networks.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a blog-only template can no longer write a post that never publishes', () => {
  // The guard asked `providers.length` — not the same question. A blog-only
  // template has one provider and no Metricool network, so it passed, skipped
  // the handoff, left handoffFailed false because nothing was attempted, and
  // wrote a posts row returning ok: true. The post then sat on the calendar
  // marked "waiting for your approval", sent nowhere, unable to ever publish.
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /if \(!metricoolNetworks\(providers\)\.length && !wantsArticle\)/);
  assert.doesNotMatch(autopilot, /if \(!providers\.length\) \{/, 'the old guard is gone');
  // And the row records what was actually sent.
  assert.match(autopilot, /opts\.schedule && \(mcProviders\.length \|\| wantsArticle\)/);
});

test('blog is filtered out of every call to Metricool, not cast into one', () => {
  // Three doors send this column onward. One filtered; two cast it straight to
  // Provider[], and one unknown entry can fail the whole multi-network call.
  for (const file of ['lib/autopilot.ts', 'app/api/templates/apply/route.ts', 'app/api/posts/route.ts']) {
    const text = src(file);
    assert.match(text, /metricoolNetworks\(/, file + ' must filter');
    assert.doesNotMatch(text, /as Provider\[\]/, file + ' still casts the raw column');
  }
  assert.deepEqual(metricoolNetworks(['blog', 'instagram']), ['instagram']);
});

test('the compliance gate covers the article, and the copy carries the lines it needs', () => {
  // Widening the gate without widening the stamping is how LinkedIn, TikTok
  // and YouTube each arrived missing the line they were about to be refused
  // for — lib/ai.ts documents that happening. So these three assert together.
  assert.equal(appliesTo(['blog']), true);
  const ai = src('lib/ai.ts');
  assert.match(ai, /'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'blog'/, 'the AVISO loop must stamp the article');
  assert.match(ai, /'linkedin', 'tiktok', 'youtube', 'blog'/, 'and the verified REF must be copied onto it');
  assert.match(src('lib/compliance.ts'), /blog-article versions/, 'and the writer told the citation carries it');
});

test('everything refusable about the article is decided BEFORE anything is sent', () => {
  // THE ONE THAT MATTERS. The first version ran these checks after Metricool
  // had already accepted the post, so a revoked WordPress password left three
  // promo posts live, scheduled, unrecorded and unreachable from this app —
  // and pressing Approve again sent three more, because there is no
  // idempotency key and no unique constraint on `posts`.
  const autopilot = src('lib/autopilot.ts');
  const preflight = autopilot.indexOf('THE ARTICLE IS DECIDED BEFORE ANYTHING IS SENT');
  const handoff = autopilot.indexOf('if (mcProviders.length) {');
  assert.ok(preflight > 0, 'the article preflight is gone');
  assert.ok(handoff > preflight, 'the preflight must come before the Metricool handoff');

  const block = autopilot.slice(preflight, handoff);
  assert.match(block, /if \(!wordpressConfigured\(\)\)/, 'no site configured is said, not guessed');
  assert.match(block, /complianceMessage\(articleCheck, \['blog'\]\)/, 'the article passes the gate first');
  assert.match(block, /professionalTitle\(/, 'and its title goes through the publishing rules');
  // Each of these refusals happens with nothing sent, and says so.
  const refusals = block.match(/Nothing was sent anywhere/g) || [];
  assert.ok(refusals.length >= 3, 'every pre-send refusal must say nothing was sent');
});

test('a send that succeeded is never thrown away for a retry', () => {
  // Releasing the run after Metricool accepted invites a second send. The
  // article failure is recorded instead, and the post is kept.
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /} else if \(metricoolPostId\) \{\s*\n\s*articleFailure = published\.message;/);
  assert.match(autopilot, /BUT THE ARTICLE WAS NOT PUBLISHED/);
  assert.match(autopilot, /approving this run again would send them a second time/);
  assert.match(autopilot, /logLine\(run, 'approve-partial', partial\)/);
});

test('a draft approval is a draft in WordPress too', () => {
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /status: opts\.schedule \? undefined : 'draft'/);
});

test('the article is sent scheduled to its slot, with the hero image', () => {
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /date: run\.scheduled_for/);
  assert.match(autopilot, /featuredImageUrl: packImage\?\.url/);
});

test('the article body is the article, not the Instagram caption', () => {
  // approveRun picks `text` for the first Metricool network. Sending that to
  // WordPress would publish a 200-word caption as an 800-word article.
  const autopilot = src('lib/autopilot.ts');
  assert.match(autopilot, /Record<string, string>\)\.blog \|\| ''\)/);
});

test('the settings are documented where somebody configuring them will read it', () => {
  const env = src('.env.example');
  assert.match(env, /WORDPRESS_BASE_URL/);
  assert.match(env, /WORDPRESS_APP_PASSWORD IS NOT YOUR LOGIN PASSWORD/);
  assert.match(env, /SITE root, not the API root/);
  assert.match(env, /THE BLOG PATH IS SIMPLY OFF/);
});

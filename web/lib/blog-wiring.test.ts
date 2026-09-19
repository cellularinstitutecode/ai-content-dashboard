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

test('a WordPress failure is a failure, not a half-send', () => {
  // The same rule the Metricool handoff follows: no posts row for a send that
  // did not happen. An article recorded as published when WordPress refused it
  // is the same lie, on the longest-lived thing the clinic publishes.
  const autopilot = src('lib/autopilot.ts');
  const blog = autopilot.slice(autopilot.indexOf('// The article, for a template that publishes one.'));
  const block = blog.slice(0, blog.indexOf('if (handoffFailed) {'));
  assert.ok(block.length > 200, 'the blog block is gone — has approveRun been rewritten?');
  assert.match(block, /if \(!wordpressConfigured\(\)\)/, 'no site configured is said, not guessed');
  assert.match(block, /handoffFailed = true/);
  assert.match(block, /complianceMessage\(check, \['blog'\]\)/, 'the article passes the gate before it is sent');
  assert.match(block, /publishArticle\(\{/);
  assert.match(block, /date: run\.scheduled_for/, 'scheduled to its slot');
  assert.match(block, /featuredImageUrl: packImage\?\.url/, 'with the hero image');
  assert.match(block, /professionalTitle\(/, 'and a title that went through the publishing rules');
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

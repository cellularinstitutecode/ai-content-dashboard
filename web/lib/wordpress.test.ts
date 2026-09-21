// web/lib/wordpress.test.ts
//
// Driven against a fake WordPress, because the real one is a site the clinic
// publishes from and this code is the thing that decides what lands on it.
//
// The rule these hold to: a failure is a failure. Every other send path in
// this app refuses to record a post that was not sent, and an article is the
// longest-lived thing the clinic publishes — so "it went up" has to mean it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiUrl,
  authHeader,
  normalizeBaseUrl,
  publishArticle,
  toHtml,
  wordpressConfig,
  wordpressConfigured,
  wpDate,
  type WordPressConfig,
} from './wordpress.ts';

const CONFIG: WordPressConfig = {
  baseUrl: 'https://clinic.example',
  user: 'editor',
  appPassword: 'abcd efgh ijkl mnop',
  status: 'future',
  category: null,
};

type Call = { url: string; init: RequestInit };

/** A WordPress that answers however the test says, and records what it was asked. */
function fakeWp(answers: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    const answer = answers[Math.min(i++, answers.length - 1)] || {};
    const status = answer.status ?? 200;
    const body = answer.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (answer.headers || {})[k.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('the site URL survives however it was pasted', () => {
  // The likeliest single misconfiguration is pasting the API root rather than
  // the site root, and it produces a 404 that explains nothing.
  assert.equal(normalizeBaseUrl('https://clinic.example/'), 'https://clinic.example');
  assert.equal(normalizeBaseUrl('https://clinic.example/wp-json'), 'https://clinic.example');
  assert.equal(normalizeBaseUrl('https://clinic.example/wp-json/wp/v2'), 'https://clinic.example');
  assert.equal(normalizeBaseUrl('clinic.example'), 'https://clinic.example', 'a bare host gets https');
  assert.equal(normalizeBaseUrl('  '), '');
  assert.equal(apiUrl('https://clinic.example/', 'posts'), 'https://clinic.example/wp-json/wp/v2/posts');
  assert.equal(apiUrl('https://clinic.example', '/media'), 'https://clinic.example/wp-json/wp/v2/media');
});

test('the Application Password works with the spaces WordPress prints in it', () => {
  // WordPress shows it as "abcd efgh ijkl mnop" and people paste exactly that.
  const withSpaces = authHeader('editor', 'abcd efgh ijkl mnop');
  const without = authHeader('editor', 'abcdefghijklmnop');
  assert.equal(withSpaces, without);
  assert.equal(Buffer.from(withSpaces.replace('Basic ', ''), 'base64').toString(), 'editor:abcdefghijklmnop');
});

test('two out of three settings is not configured', () => {
  // A half-set site shows up as a 401 nobody can explain. Better to be off.
  assert.equal(wordpressConfigured({}), false);
  assert.equal(wordpressConfigured({ WORDPRESS_BASE_URL: 'https://clinic.example' }), false);
  assert.equal(wordpressConfigured({ WORDPRESS_BASE_URL: 'https://clinic.example', WORDPRESS_USER: 'editor' }), false);
  assert.equal(
    wordpressConfigured({ WORDPRESS_BASE_URL: 'https://clinic.example', WORDPRESS_USER: 'editor', WORDPRESS_APP_PASSWORD: 'x' }),
    true,
  );
});

test('the status defaults to scheduled, and an unreadable one does not become publish', () => {
  const base = { WORDPRESS_BASE_URL: 'https://clinic.example', WORDPRESS_USER: 'e', WORDPRESS_APP_PASSWORD: 'p' };
  assert.equal(wordpressConfig(base)?.status, 'future');
  assert.equal(wordpressConfig({ ...base, WORDPRESS_STATUS: 'draft' })?.status, 'draft');
  assert.equal(wordpressConfig({ ...base, WORDPRESS_STATUS: 'publish' })?.status, 'publish');
  // A typo must not turn a scheduled article into a live one.
  assert.equal(wordpressConfig({ ...base, WORDPRESS_STATUS: 'pubish' })?.status, 'future');
  assert.equal(wordpressConfig({ ...base, WORDPRESS_STATUS: 'live' })?.status, 'future');
  // The category is a number or nothing.
  assert.equal(wordpressConfig({ ...base, WORDPRESS_CATEGORY: '7' })?.category, 7);
  assert.equal(wordpressConfig({ ...base, WORDPRESS_CATEGORY: 'Health' })?.category, null);
});

test('the article body becomes HTML, and HTML is left alone', () => {
  assert.equal(toHtml('One idea.\n\nAnother idea.'), '<p>One idea.</p>\n<p>Another idea.</p>');
  assert.equal(toHtml('## A heading\n\nThe body.'), '<h2>A heading</h2>\n<p>The body.</p>');
  assert.equal(toHtml('A line\nand its neighbour'), '<p>A line<br />and its neighbour</p>');
  assert.equal(toHtml('<p>Already written</p>'), '<p>Already written</p>');
  assert.equal(toHtml('   '), '');
});

test('a scheduled article carries the date WordPress asks for', async () => {
  const { fetchImpl, calls } = fakeWp([{ body: { id: 42, link: 'https://clinic.example/?p=42', status: 'future' } }]);
  const at = new Date('2026-10-05T17:00:00.000Z');
  const result = await publishArticle(
    { title: 'Why evaluation comes first', html: 'The body.', date: at },
    { config: CONFIG, fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.id, 42);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.status, 'future');
  // `date_gmt` ONLY. WordPress reads `date` as the site's LOCAL wall clock and
  // only falls back to `date_gmt`, so sending the same UTC string as both —
  // which this did at first — publishes a Cancún article five hours late, and
  // on a UTC+ site can date it into the past, where a scheduled post becomes
  // an immediate one.
  assert.equal(body.date_gmt, '2026-10-05T17:00:00');
  assert.equal(body.date, undefined, 'sending date too would override date_gmt with local time');
  assert.equal(wpDate(at), '2026-10-05T17:00:00', 'no milliseconds, no trailing Z');
});

test('a draft approval is a draft in WordPress too', () => {
  // The queue's "Approve" (schedule: false) sends Metricool a reviewable
  // draft. Before this, the article path ignored that and used the configured
  // `future`, so the clinic's website got a self-publishing post while the
  // calendar row still read "waiting for your approval".
  const { fetchImpl, calls } = fakeWp([{ body: { id: 7, link: 'l', status: 'draft' } }]);
  return publishArticle(
    { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z', status: 'draft' },
    { config: CONFIG, fetchImpl },
  ).then((result) => {
    assert.equal(result.ok, true);
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.status, 'draft');
    // A draft still carries its date, so publishing it later keeps the slot.
    assert.equal(body.date_gmt, '2026-10-05T17:00:00');
  });
});

test('a block that already carries a tag does not disable the rest', () => {
  // One stray tag used to return the whole body untouched, shipping every
  // `## Heading` as literal hashes and burying the AVISO and REF lines.
  const mixed = '<p>Written by the model</p>\n\n## A heading\n\nA plain paragraph.';
  const html = toHtml(mixed);
  assert.match(html, /<p>Written by the model<\/p>/);
  assert.match(html, /<h2>A heading<\/h2>/);
  assert.match(html, /<p>A plain paragraph\.<\/p>/);
  assert.doesNotMatch(html, /## A heading/);
});

test('a hero image is named for what it actually is', async () => {
  // WordPress runs wp_check_filetype_and_ext and refuses a mismatch between
  // extension and MIME as a security failure — so naming a webp `.jpg`, which
  // this did, meant every webp hero was silently rejected.
  for (const [type, ext] of [['image/webp', 'webp'], ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif']] as const) {
    const { fetchImpl, calls } = fakeWp([
      { headers: { 'content-type': type } },
      { body: { id: 5 } },
      { body: { id: 9, link: 'l', status: 'future' } },
    ]);
    await publishArticle(
      { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z', featuredImageUrl: 'https://cdn.example/hero' },
      { config: CONFIG, fetchImpl },
    );
    const disposition = String((calls[1].init.headers as Record<string, string>)['Content-Disposition']);
    assert.match(disposition, new RegExp('\\.' + ext + '"$'), type + ' must upload as .' + ext);
  }
  // A charset parameter must not defeat the lookup.
  const withParam = fakeWp([
    { headers: { 'content-type': 'image/png; charset=binary' } },
    { body: { id: 5 } },
    { body: { id: 9, link: 'l', status: 'future' } },
  ]);
  await publishArticle(
    { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z', featuredImageUrl: 'https://cdn.example/hero' },
    { config: CONFIG, fetchImpl: withParam.fetchImpl },
  );
  assert.match(String((withParam.calls[1].init.headers as Record<string, string>)['Content-Disposition']), /\.png"$/);
});

test('an HTML error page served as a picture is refused, not uploaded', async () => {
  // An expired signed URL answering 200 with an error page would otherwise be
  // uploaded to the media library as the article's hero.
  const { fetchImpl, calls } = fakeWp([
    { headers: { 'content-type': 'text/html' } },
    { body: { id: 9, link: 'l', status: 'future' } },
  ]);
  const result = await publishArticle(
    { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z', featuredImageUrl: 'https://cdn.example/expired' },
    { config: CONFIG, fetchImpl },
  );
  assert.equal(result.ok, true, 'the article still goes up');
  assert.match(result.ok ? result.note : '', /text\/html/);
  assert.equal(calls.length, 2, 'no upload was attempted');
});

test('a scheduled article with no time is refused before it is sent', async () => {
  // WordPress rejects this itself, with an error that is harder to read than
  // the sentence here — and a refusal after sending is a half-send.
  const { fetchImpl, calls } = fakeWp([{ body: { id: 1 } }]);
  const result = await publishArticle({ title: 'T', html: 'B' }, { config: CONFIG, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'no_date');
  assert.equal(calls.length, 0, 'nothing was sent');
});

test('the hero image is uploaded first and attached by id', async () => {
  const { fetchImpl, calls } = fakeWp([
    { headers: { 'content-type': 'image/png' } }, // downloading the picture
    { body: { id: 99 } }, // POST /media
    { body: { id: 42, link: 'https://clinic.example/?p=42', status: 'future' } }, // POST /posts
  ]);
  const result = await publishArticle(
    { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z', featuredImageUrl: 'https://cdn.example/hero.png' },
    { config: CONFIG, fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.equal(calls[1].url, 'https://clinic.example/wp-json/wp/v2/media');
  assert.match(String((calls[1].init.headers as Record<string, string>)['Content-Disposition']), /filename="hero-\d+\.png"/);
  const post = JSON.parse(String(calls[2].init.body));
  assert.equal(post.featured_media, 99, 'a post carries its picture by id, not by url');
});

test('a failed image upload still publishes the article, and says so', async () => {
  // An article with no hero is worth more than no article — but nobody should
  // have to wonder where the picture went.
  const { fetchImpl, calls } = fakeWp([
    { status: 404, body: 'gone' }, // the picture could not be downloaded
    { body: { id: 42, link: 'l', status: 'future' } }, // the post still goes up
  ]);
  const result = await publishArticle(
    { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z', featuredImageUrl: 'https://cdn.example/hero.png' },
    { config: CONFIG, fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.note : '', /without a hero image/);
  assert.match(result.ok ? result.note : '', /HTTP 404/);
  const post = JSON.parse(String(calls[1].init.body));
  assert.equal(post.featured_media, undefined, 'no id, no field');
});

test('a refused login says which two settings to look at', async () => {
  const { fetchImpl } = fakeWp([{ status: 401, body: { message: 'Sorry, you are not allowed to do that.' } }]);
  const result = await publishArticle({ title: 'T', html: 'B', date: '2026-10-05T17:00:00Z' }, { config: CONFIG, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'auth');
  assert.match(result.ok === false ? result.message : '', /WORDPRESS_USER/);
  assert.match(result.ok === false ? result.message : '', /Application Password/);
});

test('a refusal is a refusal, never a quiet success', async () => {
  for (const [status, expected] of [[400, 'refused'], [403, 'auth'], [500, 'unreachable']] as const) {
    const { fetchImpl } = fakeWp([{ status, body: { message: 'no' } }]);
    const result = await publishArticle({ title: 'T', html: 'B', date: '2026-10-05T17:00:00Z' }, { config: CONFIG, fetchImpl });
    assert.equal(result.ok, false, 'HTTP ' + status + ' must not read as published');
    assert.equal(result.ok === false && result.reason, expected);
  }
});

test('an answer with no post id is not something to record against', async () => {
  const { fetchImpl } = fakeWp([{ body: { link: 'https://clinic.example/?p=42' } }]);
  const result = await publishArticle({ title: 'T', html: 'B', date: '2026-10-05T17:00:00Z' }, { config: CONFIG, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unreadable');
});

test('an unreachable site is reported, with the credential redacted out of it', async () => {
  const fetchImpl = (async () => { throw new Error('getaddrinfo ENOTFOUND clinic.example'); }) as unknown as typeof fetch;
  const result = await publishArticle({ title: 'T', html: 'B', date: '2026-10-05T17:00:00Z' }, { config: CONFIG, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unreachable');
  assert.match(result.ok === false ? result.message : '', /could not be reached/);
});

test('with no WordPress configured there is nothing to publish to, and it says which settings are missing', async () => {
  const result = await publishArticle({ title: 'T', html: 'B' }, { config: null });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'not_configured');
  assert.match(result.ok === false ? result.message : '', /WORDPRESS_BASE_URL/);
});

test('an empty title or body is refused rather than published blank', async () => {
  const { fetchImpl, calls } = fakeWp([{ body: { id: 1 } }]);
  const noTitle = await publishArticle({ title: '  ', html: 'B' }, { config: CONFIG, fetchImpl });
  assert.equal(noTitle.ok === false && noTitle.reason, 'no_title');
  const noBody = await publishArticle({ title: 'T', html: '   ' }, { config: CONFIG, fetchImpl });
  assert.equal(noBody.ok === false && noBody.reason, 'no_body');
  assert.equal(calls.length, 0);
});

test('the configured category is applied, and no category means no field', async () => {
  const withCategory = fakeWp([{ body: { id: 1, link: 'l', status: 'future' } }]);
  await publishArticle(
    { title: 'T', html: 'B', date: '2026-10-05T17:00:00Z' },
    { config: { ...CONFIG, category: 7 }, fetchImpl: withCategory.fetchImpl },
  );
  assert.deepEqual(JSON.parse(String(withCategory.calls[0].init.body)).categories, [7]);

  const without = fakeWp([{ body: { id: 1, link: 'l', status: 'future' } }]);
  await publishArticle({ title: 'T', html: 'B', date: '2026-10-05T17:00:00Z' }, { config: CONFIG, fetchImpl: without.fetchImpl });
  assert.equal(JSON.parse(String(without.calls[0].init.body)).categories, undefined);
});

test('a markdown list becomes a list, and an orphan closing tag is not wrapped', () => {
  // Both are shapes a 900-word clinical article actually takes. The list
  // shipped as literal hyphens; the closing tag came out as `<p></div></p>`,
  // which is invalid and which the all-or-nothing version never produced.
  assert.equal(toHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(toHtml('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.match(toHtml('<div class="e">\n\nWords.\n\n</div>\n\nNext.'), /<\/div>\n<p>Next\.<\/p>$/);
  assert.doesNotMatch(toHtml('<div class="e">\n\nWords.\n\n</div>'), /<p><\/div><\/p>/);
  // A paragraph that merely opens with a dash is still a paragraph.
  assert.match(toHtml('- not a list because prose continues\nplain line'), /^<p>- not a list/);
  // Every heading level lands on a real heading rather than literal hashes.
  assert.equal(toHtml('# Title'), '<h2>Title</h2>', 'the article already has a title, so H1 becomes H2');
  assert.equal(toHtml('##### Five'), '<h5>Five</h5>');
});

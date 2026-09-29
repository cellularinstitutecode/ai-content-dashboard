// The AI hero image on approve: Metricool's normalise hands the Supabase link
// straight back, so the image is uploaded into Metricool's storage instead and
// the post carries that copy. Every call is answered by a local stand-in for
// fetch; nothing here reaches the network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.METRICOOL_USER_TOKEN = 'test-token';
process.env.METRICOOL_BLOG_ID = '1';
process.env.METRICOOL_USER_ID = '2';
process.env.METRICOOL_API_BASE = 'https://mc.test/api';
delete process.env.METRICOOL_DIRECT_UPLOAD;
delete process.env.METRICOOL_ACCEPT_ECHO;

const { metricoolSchedulePost, MediaNotNormalisedError } = await import('../lib/metricool.ts');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
const CONVERTED = 'https://static.metricool.com/image/2/202609/abc.png';

let calls = [];
let transactionAnswer = 200;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  transactionAnswer = 200;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : null;
    calls.push({ method, host: url.host, path: url.pathname, body, sent: url.searchParams.get('url') });
    if (url.host.endsWith('.supabase.co')) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
    }
    if (url.host === 'mc.test' && url.pathname === '/api/actions/normalize/image/url') {
      if (method === 'POST') return new Response('boom', { status: 500 });
      // The echo: the link handed straight back.
      return json(200, { data: url.searchParams.get('url') });
    }
    if (url.host === 'mc.test' && url.pathname.includes('/normalize/')) return new Response('', { status: 404 });
    if (url.host === 'mc.test' && url.pathname === '/api/v2/media/s3/upload-transactions') {
      if (method === 'PUT') {
        if (transactionAnswer !== 200) return json(transactionAnswer, { resourceType: 'Resource type is required' });
        return json(200, {
          data: {
            uploadType: 'SIMPLE',
            presignedUrl: 'https://metricool-temp.s3.eu-west-1.amazonaws.com/planner/2/202609/abc.png?X-Amz-Signature=x',
            key: 'planner/2/202609/abc.png',
            fileUrl: 'https://metricool-temp.s3.eu-west-1.amazonaws.com/planner/2/202609/abc.png',
          },
        });
      }
      return json(200, { data: { key: 'planner/2/202609/abc.png', convertedFileUrl: CONVERTED } });
    }
    if (url.host.startsWith('metricool-temp.')) return new Response('', { status: 200, headers: { etag: '"e1"' } });
    if (url.host === 'mc.test' && url.pathname === '/api/v2/scheduler/posts') return json(200, { data: { id: 42 } });
    return new Response('unexpected ' + method + ' ' + url, { status: 599 });
  };
});

const post = (url, network = 'instagram') => metricoolSchedulePost({
  text: 'Sleep and recovery',
  providers: [network],
  publicationDate: '2026-10-01T15:00:00.000Z',
  media: [{ url }],
});

test('an echoed hero image is uploaded into Metricool and the post carries the copy', async () => {
  const hero = 'https://proj.supabase.co/storage/v1/object/public/content-images/packs/one.png';
  await post(hero);
  const open = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/upload-transactions'));
  assert.ok(open, 'the upload transaction was opened');
  const declared = JSON.parse(open.body);
  assert.equal(declared.contentType, 'image/png');
  assert.equal(declared.resourceType, 'planner');
  assert.equal(declared.size, PNG.length);
  assert.equal(declared.parts.length, 1);
  assert.ok(calls.some((c) => c.method === 'PUT' && c.host.startsWith('metricool-temp.')), 'the bytes went to the signed address');
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/upload-transactions')), 'and the upload was completed');
  const sent = JSON.parse(calls.find((c) => c.path.endsWith('/scheduler/posts')).body);
  assert.deepEqual(sent.media, [CONVERTED], 'the post carries Metricool\'s copy, never the Supabase link');

  // The next network of the same approve reuses the upload.
  calls = [];
  await post(hero, 'facebook');
  assert.ok(!calls.some((c) => c.path.endsWith('/upload-transactions')), 'uploaded once per image');
  assert.ok(!calls.some((c) => c.path.includes('/normalize/')), 'and not normalised again');
  assert.deepEqual(JSON.parse(calls.find((c) => c.path.endsWith('/scheduler/posts')).body).media, [CONVERTED]);
});

test('when the upload is refused too, the refusal names the echo and the upload, not a video', async () => {
  transactionAnswer = 400;
  const hero = 'https://proj.supabase.co/storage/v1/object/public/content-images/packs/two.png';
  await assert.rejects(post(hero), (e) => {
    assert.ok(e instanceof MediaNotNormalisedError);
    assert.match(e.message, /did not take the image/);
    assert.match(e.message, /handed the same link straight back/);
    assert.match(e.message, /image 200/);
    assert.match(e.message, /Metricool answered 400 when asked to open an image upload/);
    assert.doesNotMatch(e.message, /video/);
    return true;
  });
  assert.ok(!calls.some((c) => c.path.endsWith('/scheduler/posts')), 'no post is created');
});

test('a Drive video link keeps its refusal and is never uploaded as an image', async () => {
  const drive = 'https://drive.usercontent.google.com/download?id=1AbC_dEfGhIjKlMnOpQrStUvWxYz012345&export=download';
  await assert.rejects(post(drive), (e) => {
    assert.ok(e instanceof MediaNotNormalisedError);
    assert.match(e.message, /without its video/);
    return true;
  });
  assert.ok(!calls.some((c) => c.path.endsWith('/upload-transactions')), 'no image upload for a Drive link');
  assert.ok(!calls.some((c) => c.path.endsWith('/scheduler/posts')));
});

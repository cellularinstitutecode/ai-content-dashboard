// web/lib/metricool-upload-parse.test.ts
//
// THE 149 MB THAT HAD NO ROUTE. "Metricool handed the same link straight back
// instead of a copy of its own, which means it did not take the file. The file
// is 149 MB. Tried image 200 · video 404 · v2/video 404 · v2/image 404 · image
// POST 500 · … The video link this app handed over is fine (149 MB), so the
// file itself is not the problem."
//
// It was not. The LINK was: a Drive address, which Metricool hands back at any
// size, and there was no host of ours that could serve the file instead. So
// the app now does what Metricool's own uploader does — opens an upload
// transaction and puts the bytes on Metricool's storage itself — and these
// tests pin down the two readings that make that safe:
//   1. Metricool's reply is read for the upload address and the file address
//      in any reasonable shape, and nothing is invented when there is none.
//   2. A URL already on Metricool's storage is sent as is, never through
//      normalise — where it would be handed back and refused as an echo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  directUploadEnabled,
  isMetricoolCopyId,
  isMetricoolHostedUrl,
  metricoolCopyId,
  readUploadTransaction,
} from './metricool-upload-parse.ts';
import { copyRouteFor } from './copy-source.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MB = 1024 * 1024;

const SIGNED =
  'https://metricool-download.s3.eu-west-1.amazonaws.com/uploads/12345/reel.mp4' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260921%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20260921T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123';
const FILE = 'https://metricool-download.s3.eu-west-1.amazonaws.com/uploads/12345/reel.mp4';
const STATIC = 'https://static.metricool.com/uploads/12345/reel.mp4';

// --- reading the transaction -------------------------------------------------

test('a pre-signed address under a key that says so, and the file address beside it', () => {
  const tx = readUploadTransaction(JSON.stringify({ id: 'tx_1', uploadUrl: SIGNED, url: STATIC }));
  assert.equal(tx.uploadUrl, SIGNED);
  assert.equal(tx.fileUrl, STATIC);
  assert.equal(tx.id, 'tx_1');
  assert.equal(tx.method, 'PUT');
});

test('when only the signed address comes back, the file is that address without its signature', () => {
  // What an S3 object is called once the PUT has completed.
  for (const body of [{ presignedUrl: SIGNED }, { data: { upload: { url: SIGNED } } }, SIGNED, '"' + SIGNED + '"']) {
    const tx = readUploadTransaction(typeof body === 'string' ? body : JSON.stringify(body));
    assert.equal(tx.uploadUrl, SIGNED, JSON.stringify(body).slice(0, 40));
    assert.equal(tx.fileUrl, FILE);
  }
});

test('every other shape a REST API plausibly answers with', () => {
  const shapes: Record<string, unknown> = {
    '{signedUrl, publicUrl}': { signedUrl: SIGNED, publicUrl: STATIC },
    '{data:{putUrl, downloadUrl}}': { data: { putUrl: SIGNED, downloadUrl: STATIC } },
    '{transaction:{uploadUrl}, media:{url}}': { transaction: { uploadUrl: SIGNED }, media: { url: STATIC } },
    '{url (signed), fileUrl}': { url: SIGNED, fileUrl: STATIC },
    'array': [{ uploadUrl: SIGNED, url: STATIC }],
  };
  for (const [name, body] of Object.entries(shapes)) {
    const tx = readUploadTransaction(JSON.stringify(body));
    assert.equal(tx.uploadUrl, SIGNED, name + ' upload');
    assert.equal(tx.fileUrl, STATIC, name + ' file');
  }
});

test('a signed address anywhere beats an unsigned one under an upload key', () => {
  const tx = readUploadTransaction(JSON.stringify({ upload: 'https://app.metricool.com/api/v2/media/upload', target: SIGNED }));
  assert.equal(tx.uploadUrl, SIGNED);
});

test('headers and form fields are carried verbatim, and a form means POST', () => {
  const put = readUploadTransaction(JSON.stringify({ uploadUrl: SIGNED, headers: { 'x-amz-acl': 'public-read', 'Content-Type': 'video/mp4' } }));
  assert.deepEqual(put.headers, { 'x-amz-acl': 'public-read', 'Content-Type': 'video/mp4' });
  assert.equal(put.method, 'PUT');

  const post = readUploadTransaction(JSON.stringify({
    url: 'https://metricool-download.s3.eu-west-1.amazonaws.com/',
    fields: { key: 'uploads/12345/reel.mp4', policy: 'eyJ…', 'x-amz-signature': 'abc', bucket: 'metricool-download' },
  }));
  assert.equal(post.method, 'POST');
  assert.equal(post.uploadUrl, 'https://metricool-download.s3.eu-west-1.amazonaws.com/');
  assert.equal(post.fields?.key, 'uploads/12345/reel.mp4');
  // An explicit method wins over the guess.
  assert.equal(readUploadTransaction(JSON.stringify({ method: 'POST', uploadUrl: SIGNED })).method, 'POST');
});

test('a bucket and a key with no URL at all still name the file', () => {
  const tx = readUploadTransaction(JSON.stringify({ bucket: 'metricool-download', key: 'uploads/1/reel.mp4', uploadUrl: 'https://upload.example/x?Signature=1' }));
  assert.equal(tx.fileUrl, 'https://metricool-download.s3.eu-west-1.amazonaws.com/uploads/1/reel.mp4');
  assert.equal(tx.id, 'uploads/1/reel.mp4', 'the key stands in for an id');
});

test('nothing is invented', () => {
  // Every one of these must leave uploadUrl null: a PUT to a guessed address
  // is bytes sent to nobody, reported as success.
  for (const raw of ['', 'ok', '{}', '{"ok":true}', '{"status":"created","id":"tx_9"}', '[]', 'null']) {
    const tx = readUploadTransaction(raw);
    assert.equal(tx.uploadUrl, null, JSON.stringify(raw));
    assert.equal(tx.fileUrl, null, JSON.stringify(raw));
  }
  // The shape is reported in types, never values, so a reply nobody
  // anticipated is a five-minute fix and a credential is never displayed.
  const tx = readUploadTransaction(JSON.stringify({ status: 'created', token: 'SECRET', id: 'tx_9' }));
  assert.equal(tx.shape, '{status:string, token:string, id:string}');
  assert.ok(!tx.shape.includes('SECRET'));
});

// --- knowing Metricool's storage when it is seen ------------------------------

test('a URL already on Metricool’s storage needs no normalise', () => {
  for (const url of [
    STATIC,
    FILE,
    'https://metricool-data.s3.eu-west-1.amazonaws.com/x/y.mp4',
    'https://metricool-media.s3-eu-west-1.amazonaws.com/x/y.mp4',
    'https://s3.eu-west-1.amazonaws.com/metricool-download/x/y.mp4',
    'https://cdn.metricool.com/media/9f3a2b.mp4',
  ]) assert.equal(isMetricoolHostedUrl(url), true, url);
});

test('and nothing else does — least of all the API host or a link of ours', () => {
  for (const url of [
    'https://app.metricool.com/api/actions/normalize/image/url',
    'https://drive.usercontent.google.com/download?id=abc&export=download&confirm=t',
    'https://studio.example.com/api/media/video/abc/1800000000/ff/video.mp4',
    'https://xyz.supabase.co/storage/v1/object/public/content-videos/videos/abc.mp4',
    'https://s3.eu-west-1.amazonaws.com/somebody-else/metricool-download/x.mp4',
    'http://static.metricool.com/x.mp4',
    '',
    'not a url',
  ]) assert.equal(isMetricoolHostedUrl(url), false, url);
});

test('lib/metricool.ts sends a hosted URL as is, and the list does not read that as an echo', () => {
  const lib = src('lib/metricool.ts');
  assert.match(lib, /if \(isMetricoolHostedUrl\(url\)\)/, 'the pass-through must be the first thing normalise checks');
  assert.match(lib, /hosted: true/, 'and say so');
  assert.match(lib, /if \(n === trimmed && !out\.ok\)/, 'unchanged-and-ok is the file where it belongs, not a refusal');
});

// --- the switch, the marker, the route ---------------------------------------

test('on unless somebody turns it off', () => {
  assert.equal(directUploadEnabled({}), true);
  assert.equal(directUploadEnabled({ METRICOOL_DIRECT_UPLOAD: 'on' }), true);
  for (const v of ['off', 'OFF', 'false', '0', 'no']) assert.equal(directUploadEnabled({ METRICOOL_DIRECT_UPLOAD: v }), false, v);
});

test('the copy marker carries a colon, so no delete path can mistake it for a Drive id', () => {
  const id = metricoolCopyId('uploads/12345/reel.mp4');
  assert.ok(isMetricoolCopyId(id));
  assert.ok(id.includes(':'));
  assert.ok(!/^[A-Za-z0-9_-]{20,80}$/.test(id), 'deleteDriveFile’s own guard refuses it');
  assert.equal(isMetricoolCopyId('stream:abc'), false);
  assert.equal(isMetricoolCopyId('videos/abc.mp4'), false);
});

test('the router puts the upload before every route that hands over a link', () => {
  const vercel = { VERCEL_PROJECT_PRODUCTION_URL: 'ai-content-dashboard-pi.vercel.app' };
  const base = 'https://ai-content-dashboard-pi.vercel.app';
  // The 149 MB reel from the screen: no bucket, no host, and until now a refusal.
  assert.deepEqual(copyRouteFor({ staged: false, sizeBytes: 149 * MB, base, env: vercel, directUpload: { available: true } }), { source: 'metricool' });
  // Before the Drive copy too: a Drive link is handed back at any size.
  assert.deepEqual(copyRouteFor({ staged: false, sizeBytes: 80 * MB, base, env: vercel, directUpload: { available: true } }), { source: 'metricool' });
  // The bucket still wins when the file fits — that route is proven.
  assert.deepEqual(copyRouteFor({ staged: true, sizeBytes: 40 * MB, base, env: vercel, directUpload: { available: true } }), { source: 'bucket' });
  // Not available: the older order holds exactly.
  assert.deepEqual(copyRouteFor({ staged: false, sizeBytes: 80 * MB, base, env: vercel, directUpload: { available: false } }), { source: 'drive' });
});

test('when the upload was tried and failed, the refusal says what Metricool answered', () => {
  const vercel = { VERCEL_PROJECT_PRODUCTION_URL: 'ai-content-dashboard-pi.vercel.app' };
  const route = copyRouteFor({
    staged: false, sizeBytes: 149 * MB, base: 'https://ai-content-dashboard-pi.vercel.app', env: vercel,
    directUpload: { available: false, note: 'Metricool answered 404 when asked to open an upload — no such endpoint on this account' },
  });
  assert.equal(route.source, 'refuse');
  const message = route.source === 'refuse' ? route.message : '';
  assert.match(message, /^Uploading this video straight into Metricool was tried first and did not work: Metricool answered 404/);
  assert.match(message, /THREE WAYS OUT/, 'and the older ways out still follow');
});

test('the copy maker tries the upload only when the bucket would not take the file', () => {
  const lib = src('lib/media-library.ts');
  assert.match(lib, /available: !staged\.ok && directUploadPossible\(sizeBytes\)/);
  assert.match(lib, /uploadVideoToMetricool\(fileId, title, \{ blogId: who\?\.blogId \}\)/, 'for the brand the post is for');
  assert.match(lib, /where: 'metricool'/, 'and records where the bytes went');
  // A failed upload is a NOTE on the refusal, never a thrown error.
  assert.match(lib, /directUpload = \{ available: false, note: direct\.message \}/);
});

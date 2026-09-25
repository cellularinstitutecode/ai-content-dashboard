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
// tests pin down the readings that make that safe:
//   1. The transaction is sent exactly as Metricool's web app sends it, which
//      was captured on 21 September (the section at the end of this file);
//      the generic reader below it is the fallback that describes a reply
//      this code does not expect, and nothing is invented when a field is
//      missing.
//   2. A URL already on Metricool's storage is sent as is, never through
//      normalise — where it would be handed back and refused as an echo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UPLOAD_PART_BYTES,
  acceptedValues,
  bareEtag,
  completionBody,
  directUploadEnabled,
  isMetricoolCopyId,
  isMetricoolHostedUrl,
  metricoolCopyId,
  partRanges,
  readCompletedTransaction,
  derivedConvertedUrl,
  earliestExpiry,
  readOpenedTransaction,
  signedUrlExpiry,
  readUploadTransaction,
  refusedFields,
  transactionBody,
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

// --- what the real sends taught --------------------------------------------------

/** Metricool's actual answer to #300's body, verbatim from the screen. */
const METRICOOL_400 = '{"status":"BAD_REQUEST","code":"400","title":"ValidationError","detail":{"resourceType":"Resource type is required","parts":"Parts list is required"}}';

test('the refusal names the fields it wants, and they are read rather than guessed', () => {
  assert.deepEqual(refusedFields(METRICOOL_400), ['resourcetype', 'parts']);
  assert.deepEqual(refusedFields('{"detail":{"parts":"At least one part is required"}}'), ['parts']);
  assert.deepEqual(refusedFields('{"errors":[{"field":"resourceType","message":"x"}]}'), ['resourcetype']);
  assert.deepEqual(refusedFields('not json'), []);
  assert.deepEqual(refusedFields('{"status":"BAD_REQUEST"}'), []);
});

test('a wrong enum value gets the accepted list back, and the list is read', () => {
  const jackson = 'JSON parse error: Cannot deserialize value of type `com.metricool.ResourceType` from String "FILE": not one of the values accepted for Enum class: [IMAGE, VIDEO, DOCUMENT]';
  assert.deepEqual(acceptedValues(jackson), ['IMAGE', 'VIDEO', 'DOCUMENT']);
  assert.deepEqual(acceptedValues('{"detail":{"resourceType":"must be one of allowed values [image, video]"}}'), ['image', 'video']);
  assert.deepEqual(acceptedValues(METRICOOL_400), [], 'a missing field is not a wrong value');
});

test('a multipart reply is read part by part, with its upload id and key', () => {
  const p1 = SIGNED + '&partNumber=1&uploadId=abc.def';
  const p2 = SIGNED + '&partNumber=2&uploadId=abc.def';
  const tx = readUploadTransaction(JSON.stringify({
    id: 'tx_7', uploadId: 'abc.def', key: 'uploads/12345/reel.mp4',
    parts: [{ partNumber: 2, url: p2 }, { partNumber: 1, url: p1 }],
  }));
  assert.equal(tx.parts.length, 2);
  assert.equal(tx.parts[0].partNumber, 1, 'in numbered order, whatever order the reply used');
  assert.equal(tx.uploadUrl, p1, 'the first part is where a single-part upload goes');
  assert.equal(tx.uploadId, 'abc.def');
  assert.equal(tx.key, 'uploads/12345/reel.mp4');
  assert.equal(tx.id, 'tx_7');
  assert.equal(tx.fileUrl, FILE, 'the object is the part address without its query');
  // A plain signed PUT has no parts and no upload id.
  const single = readUploadTransaction(JSON.stringify({ uploadUrl: SIGNED }));
  assert.equal(single.parts.length, 1, 'a lone signed address is still one part');
  assert.equal(single.uploadId, null);
});

// --- the protocol, captured 21 September from Metricool's own uploader ------------
//
// A 5 KB test clip saved as a draft (then deleted) on app.metricool.com, with
// the page's fetch/XHR wrapped. These are its four messages, credentials and
// signatures removed, and the uploader's own constants from its bundle:
// MAX_FILE_SIZE_BYTES 95 MB, CHUNK_FILE_SIZE_BYTES 50 MB, CHUNK_MIN_PART_SIZE_BYTES 25 MB.

const CAPTURED_HASH = 'IZl5inPD3WpXqREk58cLyWdb6ot0vIAzP4Ibhe5/Wpk=';
const CAPTURED_REQUEST = { resourceType: 'planner', contentType: 'video/mp4', size: 5061, parts: [{ size: 5061, startByte: 0, endByte: 5061, hash: CAPTURED_HASH }] };
const CAPTURED_KEY = 'planner/3377431/202609/b6d69a8c9f414e05.mp4';
const CAPTURED_FILE = 'https://metricool-temp.s3.eu-west-1.amazonaws.com/' + CAPTURED_KEY;
const CAPTURED_SIGNED = CAPTURED_FILE + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=x&X-Amz-Date=20260921T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=x';
const CAPTURED_OPENED = JSON.stringify({ data: {
  key: CAPTURED_KEY, bucket: 'metricool-temp', expiresAt: 1790034319.252856312, fileUrl: CAPTURED_FILE, presignedUrl: CAPTURED_SIGNED,
  uploadId: null, parts: null, totalSize: 5061, uploadType: 'SIMPLE',
} });
const CAPTURED_CONVERTED = 'https://static.metricool.com/video/3377431/202609/b6d69a8c9f414e05.mp4';
const CAPTURED_COMPLETED = JSON.stringify({ data: { key: CAPTURED_KEY, bucket: 'metricool-temp', fileUrl: CAPTURED_FILE, etag: null, convertedFileUrl: CAPTURED_CONVERTED } });

test('the file is declared in 25 MB slices, [start, end), and the body is exactly the web app’s', () => {
  assert.equal(UPLOAD_PART_BYTES, 25 * MB);
  assert.deepEqual(partRanges(5061), [{ startByte: 0, endByte: 5061, size: 5061 }]);
  assert.deepEqual(partRanges(149 * MB).map((p) => p.size), [25 * MB, 25 * MB, 25 * MB, 25 * MB, 25 * MB, 24 * MB], 'six slices for the 149 MB reel');
  assert.equal(partRanges(149 * MB).at(-1)?.endByte, 149 * MB);
  assert.deepEqual(partRanges(0), []);
  // The captured request, field for field — and only those fields.
  const body = transactionBody({ contentType: 'video/mp4', size: 5061, parts: [{ ...CAPTURED_REQUEST.parts[0], hash: CAPTURED_HASH }] });
  assert.deepEqual(body, CAPTURED_REQUEST);
  assert.equal(JSON.stringify(body), JSON.stringify(CAPTURED_REQUEST), 'same key order too');
  // A part is an OBJECT. The bare number Metricool’s Jackson could not build an S3UploadPart from is gone.
  assert.equal(typeof body.parts[0], 'object');
});

test('the reply to a simple upload is read as captured', () => {
  const tx = readOpenedTransaction(CAPTURED_OPENED);
  assert.equal(tx.uploadType, 'SIMPLE');
  assert.equal(tx.presignedUrl, CAPTURED_SIGNED);
  assert.equal(tx.fileUrl, CAPTURED_FILE);
  assert.equal(tx.key, CAPTURED_KEY);
  assert.equal(tx.bucket, 'metricool-temp');
  assert.equal(tx.uploadId, null);
  assert.deepEqual(tx.parts, []);
  assert.deepEqual(completionBody(tx, []), { simple: { fileUrl: CAPTURED_FILE } });
  // The web app’s own fallback: no fileUrl, the signed address itself.
  assert.deepEqual(completionBody({ ...tx, fileUrl: null }, []), { simple: { fileUrl: CAPTURED_SIGNED } });
});

test('a multipart reply carries one signed address per part, and its completion is made of ETags', () => {
  const part = (n: number) => ({ partNumber: n, presignedUrl: CAPTURED_SIGNED + '&partNumber=' + n + '&uploadId=abc.def', startByte: (n - 1) * 25 * MB, endByte: n * 25 * MB });
  const tx = readOpenedTransaction(JSON.stringify({ data: {
    key: CAPTURED_KEY, bucket: 'metricool-temp', fileUrl: CAPTURED_FILE, presignedUrl: null, uploadId: 'abc.def',
    parts: [part(2), part(1)], totalSize: 50 * MB, uploadType: 'MULTIPART',
  } }));
  assert.equal(tx.uploadType, 'MULTIPART');
  assert.equal(tx.uploadId, 'abc.def');
  assert.equal(tx.presignedUrl, null);
  assert.deepEqual(tx.parts.map((p) => p.partNumber), [1, 2], 'in numbered order, whatever order the reply used');
  assert.equal(tx.parts[1].startByte, 25 * MB);
  assert.deepEqual(
    completionBody(tx, [{ partNumber: 2, etag: 'e2' }, { partNumber: 1, etag: 'e1' }]),
    { multipart: { uploadId: 'abc.def', key: CAPTURED_KEY, parts: [{ partNumber: 1, etag: 'e1' }, { partNumber: 2, etag: 'e2' }] } },
  );
  // A part with no address, or a number missing, is read defensively — never invented.
  const thin = readOpenedTransaction(JSON.stringify({ uploadType: 'MULTIPART', uploadId: 'u', key: 'k', parts: [{ presignedUrl: CAPTURED_SIGNED }, { url: 'not a url' }] }));
  assert.deepEqual(thin.parts, [{ partNumber: 1, presignedUrl: CAPTURED_SIGNED, startByte: null, endByte: null }]);
  assert.equal(readOpenedTransaction('not json').uploadType, null);
  assert.equal(readOpenedTransaction('{"data":{"uploadType":"weird"}}').uploadType, null);
});

test('the completion names the converted copy, which is the address the post carries', () => {
  const done = readCompletedTransaction(CAPTURED_COMPLETED);
  assert.equal(done.convertedFileUrl, CAPTURED_CONVERTED);
  assert.equal(done.fileUrl, CAPTURED_FILE);
  assert.equal(done.key, CAPTURED_KEY);
  assert.equal(done.etag, null);
  assert.ok(isMetricoolHostedUrl(done.convertedFileUrl), 'static.metricool.com: sent as is, never normalised');
  assert.ok(isMetricoolHostedUrl(done.fileUrl), 'and the temp bucket is Metricool storage too');
  assert.equal(readCompletedTransaction('{}').convertedFileUrl, null);
  // S3 quotes ETags; the completion wants them bare.
  assert.equal(bareEtag('"abc123"'), 'abc123');
  assert.equal(bareEtag('W/"abc123"'), 'abc123');
  assert.equal(bareEtag(null), null);
});

test('the uploader sends the captured protocol word for word', () => {
  const lib = src('lib/metricool-upload.ts');
  assert.match(lib, /transactionBody\(\{ contentType: input\.contentType, size: input\.bytes, parts: input\.parts \}\)/, 'the body is the pure one, tested above');
  assert.match(lib, /createHash\('sha256'\)/, 'each slice is hashed');
  assert.match(lib, /hash\.digest\('base64'\)/, 'base64, as x-amz-checksum-sha256 wants it');
  assert.match(lib, /'x-amz-checksum-sha256': input\.hash/, 'and sent with every PUT');
  assert.match(lib, /method: 'PATCH',\s*body: JSON\.stringify\(completion\)/, 'completed with a PATCH to the same path');
  assert.match(lib, /finished\.convertedFileUrl \|\| finished\.fileUrl \|\| tx\.fileUrl/, 'the converted copy first');
  // Nothing is guessed any more.
  assert.doesNotMatch(lib, /enumGuesses|partShapes|acceptedValues|doors/, 'the guessing loop is gone');
  // The bytes come down before the transaction opens: the declaration needs their hashes.
  assert.ok(lib.indexOf('await declareParts(tmp, bytes)') < lib.indexOf('await openTransaction('), 'download, hash, then open');
  // Every refusal still reaches the screen, redacted, and a failed completion is never a success.
  assert.match(lib, /It said: ' \+ opened\.detail/);
  assert.match(lib, /redact\(String\(text \|\| ''\)\)/);
  assert.match(lib, /to completing the upload, so it has no file yet/);
});

test('above the scratch disk the file is streamed, not refused', () => {
  // The 477 MB reel: "more than the 360 MB this function can stage for an
  // upload", while the 149 MB ones went out. The disk was the ceiling, and
  // the disk is not needed: one pass to hash, then each slice by Range.
  const lib = src('lib/metricool-upload.ts');
  assert.match(lib, /export const DIRECT_UPLOAD_STAGE_BYTES = DISK_SAFE_BYTES/, 'the disk path keeps its ceiling');
  assert.match(lib, /export const DIRECT_UPLOAD_MAX_BYTES = 5 \* 1024 \* 1024 \* 1024/, 'the route’s ceiling is one hashing pass, not storage');
  assert.match(lib, /const streamed = sizeBytes != null && sizeBytes > DIRECT_UPLOAD_STAGE_BYTES/, 'streamed only above the disk, and only with a known size');
  assert.match(lib, /await declarePartsFromDrive\(id, sizeBytes/, 'one pass to hash');
  assert.match(lib, /await partFromDrive\(id, start, end, contentType/, 'then each slice by Range request');
  assert.match(lib, /range: 'bytes=' \+ startByte \+ '-' \+ \(endByte - 1\)/, 'an inclusive HTTP range');
  assert.match(lib, /if \(total !== size\) throw new Error\('The download stopped at/, 'the byte count is checked, as on disk');
  assert.match(lib, /'content-length': String\(input\.bytes\)/, 'a whole-file PUT names its length');
  // The staged path is untouched: same download, same hashing, same order.
  assert.match(lib, /await declareParts\(tmp, bytes\)/);
});

test('a signed address says when it expires, and the opened reply carries it', () => {
  // X-Amz-Date=20260921T000000Z + X-Amz-Expires=3600 → 01:00 UTC that day.
  assert.equal(signedUrlExpiry(CAPTURED_SIGNED), Date.UTC(2026, 8, 21, 1, 0, 0));
  assert.equal(signedUrlExpiry('https://x.example/no-signature'), null);
  assert.equal(signedUrlExpiry('https://x.example/?X-Amz-Date=garbage&X-Amz-Expires=3600'), null);
  assert.equal(signedUrlExpiry(''), null);
  // The reply's own expiresAt is read, in any of the ways an API writes one
  // (here the signed address carries no date of its own).
  const at = Date.UTC(2026, 8, 25, 12, 0, 0);
  const undated = 'https://metricool-temp.s3.eu-west-1.amazonaws.com/k?Signature=abc';
  for (const v of [at, Math.floor(at / 1000), new Date(at).toISOString(), String(at)]) {
    const tx = readOpenedTransaction(JSON.stringify({ data: { uploadType: 'MULTIPART', uploadId: 'u', key: 'k', parts: [{ partNumber: 1, presignedUrl: undated }], expiresAt: v } }));
    assert.equal(tx.expiresAt, at, JSON.stringify(v));
  }
  // When both are known, the SOONER one is the truth: S3 stops answering at its own.
  const both = readOpenedTransaction(JSON.stringify({ data: { uploadType: 'MULTIPART', uploadId: 'u', key: 'k', parts: [{ partNumber: 1, presignedUrl: CAPTURED_SIGNED }], expiresAt: at } }));
  assert.equal(both.expiresAt, Date.UTC(2026, 8, 21, 1, 0, 0));
  // Without one, the first signed address decides.
  const tx = readOpenedTransaction(JSON.stringify({ data: { uploadType: 'MULTIPART', uploadId: 'u', key: 'k', parts: [{ partNumber: 1, presignedUrl: CAPTURED_SIGNED }] } }));
  assert.equal(tx.expiresAt, Date.UTC(2026, 8, 21, 1, 0, 0));
  assert.equal(readOpenedTransaction('{"data":{"uploadType":"SIMPLE","presignedUrl":"https://x.example/plain"}}').expiresAt, null);
});

test('a reel one request cannot finish is resumed by the next, never restarted', () => {
  // Row 200: 2785 MB. No single 300-second request moves that, and the first
  // version refused it past 2 GB. A multipart upload resumes by construction.
  const lib = src('lib/metricool-upload.ts');
  assert.match(lib, /const prior = streamed \? await loadUploadState\(id\) : null/, 'an earlier request’s state is looked for');
  assert.match(lib, /declared = prior\.declared/, 'its hashes are reused — the expensive pass is paid once');
  assert.match(lib, /prior\.expiresAt - Date\.now\(\) > 60_000/, 'its signed addresses only while they are good');
  assert.match(lib, /const todo = tx\.parts\.filter\(\(p\) => !etags\[String\(p\.partNumber\)\]\)/, 'slices already there are not sent again');
  assert.match(lib, /if \(resumable && left\(\) < BATCH_RESERVE_MS\)/, 'it stops before a batch it cannot finish');
  assert.match(lib, /reason: 'pending'/, 'and says so, as progress rather than failure');
  assert.match(lib, /if \(resumable\) await saveUploadEtags\(id, etags\)/, 'banking the ETags after every batch');
  assert.match(lib, /if \(resumable\) await finishUploadState\(id, \{ fileUrl, copyId \}\)/, 'and closing the record when it lands');
  assert.match(lib, /if \(resumable\) await resetUploadState\(id, message\)/, 'a refused slice keeps the hashes and drops the addresses');
  // The copy maker passes "pending" up as its own thing, and tries no other route meanwhile.
  const media = src('lib/media-library.ts');
  assert.match(media, /direct\.reason === 'pending'/);
  assert.match(media, /code: 'upload_pending'/);
  // The state lives in its own table, named for the health check.
  const probe = src('lib/schema-probe.ts');
  assert.match(probe, /table: 'metricool_uploads'/);
  assert.match(probe, /file: 'supabase\/metricool-uploads\.sql'/);
  const sql = src('supabase/metricool-uploads.sql');
  assert.match(sql, /create table if not exists public\.metricool_uploads/);
  for (const col of ['declared jsonb', 'transaction jsonb', 'etags jsonb', 'expires_at timestamptz']) assert.ok(sql.includes(col), col);
});

test('an expiry that cannot be a time is not one — a duration read as an epoch is 1970', () => {
  // {"expiresAt":3600} read as epoch seconds is 1970; an upload judged by it
  // would be reopened on every pass and its slices thrown away each time.
  const at = Date.UTC(2026, 8, 25, 12, 0, 0);
  assert.equal(earliestExpiry([3600 * 1000, at]), at, 'the 1970 reading is ignored');
  assert.equal(earliestExpiry([at + 60_000, at]), at, 'the soonest of two real times');
  assert.equal(earliestExpiry([null, undefined, NaN, 0]), null);
  const tx = readOpenedTransaction(JSON.stringify({ data: { uploadType: 'MULTIPART', uploadId: 'u', key: 'k', parts: [{ partNumber: 1, presignedUrl: CAPTURED_SIGNED }], expiresAt: 3600 } }));
  assert.equal(tx.expiresAt, Date.UTC(2026, 8, 21, 1, 0, 0), 'falls back to the signed address');
});

test('the audit after #322: one request at a time, hashing that resumes, the sweep’s own clock', () => {
  const lib = src('lib/metricool-upload.ts');
  // 1. The composer sends to three networks in parallel; each asked for the copy.
  assert.match(lib, /claimed = await claimUpload\(id, sizeBytes as number, opts\.blogId \?\? null\)/, 'a streamed upload is claimed before the file is touched');
  assert.match(lib, /if \(claimed\) await releaseUpload\(id\);/, 'and released on every way out');
  assert.match(lib, /being uploaded into Metricool by another request right now/, 'the others say so instead of starting a second one');
  // 2. The hashing pass was the one thing that had to fit a single request.
  assert.match(lib, /declared: prior && priorFits \? prior\.declared : \[\]/, 'it resumes from the slices an earlier request measured');
  assert.match(lib, /stopWhen: \(\) => left\(\) < BATCH_RESERVE_MS/, 'and stops at a slice boundary while there is time to bank');
  assert.match(lib, /await saveHashingProgress\(id, \{ sizeBytes: sizeBytes as number, declared: pass\.declared/, 'banked whether or not it finished');
  assert.match(lib, /Measuring the video for Metricool: /, 'and reported as progress, not failure');
  assert.match(lib, /range: 'bytes=' \+ from \+ '-'/, 'the next pass reads on from the last slice');
  // 3. The sweep's own clock reaches the upload.
  const sweep = src('lib/video-autopilot.ts');
  assert.equal((sweep.match(/budgetMs: Math\.max\(20_000, budgetMs - \(Date\.now\(\) - started\)\)/g) || []).length >= 3, true, 'attach, first hand-off and the owed hand-off all pass what is left');
  const attach = src('lib/video-attach.ts');
  assert.match(attach, /budgetMs: args\.budgetMs/);
  // 4. Networks that need the video are named when it is missing, and made when it lands.
  assert.match(sweep, /const owed = networksFor\(networks, true, format, published\)\.filter\(\(n\) => !wanted\.includes\(n\)\)/, 'the hand-off names what it dropped');
  assert.match(sweep, /reason: noVideo\?\.code === 'upload_pending' \? \('upload_pending' as const\) : \('no_video' as const\)/);
  assert.match(sweep, /const owedNets = priorOutcomes\.filter\(\(p\) => !p\.ok && \(p\.reason === 'upload_pending' \|\| p\.reason === 'no_video'\)\)/, 'a later pass reads them back');
  assert.match(sweep, /const copyNow = await cachedPublicCopy\(owedFileId\)/, 'and makes the drafts once the copy exists');
  assert.match(sweep, /draftId: prior\.draft_id, title: typeof pack\.title === 'string'/, 'onto the same draft');
  const publish = src('lib/video-publish.ts');
  assert.match(publish, /\| 'upload_pending'/);
  // 5. The table carries the claim and the partial hashing.
  const sql = src('supabase/metricool-uploads.sql');
  assert.match(sql, /alter column transaction drop not null/);
  assert.match(sql, /add column if not exists hashed_bytes bigint/);
  assert.match(sql, /add column if not exists claimed_until timestamptz/);
  const state = src('lib/metricool-upload-state.ts');
  assert.match(state, /or\('claimed_until\.is\.null,claimed_until\.lt\.' \+ now\.toISOString\(\)\)/, 'a claim is taken only when free or stale');
  assert.match(state, /made\.error\.code !== '23505'/, 'a duplicate insert is the other request winning, not an error');
});

test('the converted copy’s address follows from the key, and nowhere else', () => {
  // Captured: key planner/<user>/<yyyymm>/<id>.mp4 → static.metricool.com/video/<user>/<yyyymm>/<id>.mp4.
  assert.equal(derivedConvertedUrl('planner/4308292/202609/abc123.mp4'), 'https://static.metricool.com/video/4308292/202609/abc123.mp4');
  assert.equal(derivedConvertedUrl('/planner/4308292/202609/abc123.MOV'), 'https://static.metricool.com/video/4308292/202609/abc123.MOV');
  for (const k of ['uploads/x.mp4', 'planner/x.png', 'planner/', '', null, undefined]) assert.equal(derivedConvertedUrl(k), null, String(k));
});

test('row 200: the completion converts the video, so it is waited for, and a timeout there is not a failure', () => {
  // "Metricool timed out after 30s" was the last word after the whole 2785 MB
  // had gone up: the completion was given a small call's timeout while
  // Metricool converted the file, and the next pass would have asked it to
  // complete an upload it had already completed.
  const lib = src('lib/metricool-upload.ts');
  assert.match(lib, /timeoutMs: Math\.max\(CALL_MS, left\(\) - 5_000\),\s*blogId: opts\.blogId,/, 'the completion gets the whole of what is left');
  assert.match(lib, /and Metricool was still converting it when this request ran out of time/, 'a timeout is "still converting"');
  assert.match(lib, /reason: 'pending', sizeBytes, progress: \{ done: tx\.parts\.length \|\| 1, total: tx\.parts\.length \|\| 1 \}/, 'reported as progress, with the state kept');
  assert.match(lib, /const alreadyThere = derivedConvertedUrl\(tx\.key\)/, 'the converted copy is looked for');
  assert.match(lib, /const probe = await verifyPlayableMp4\(alreadyThere, null, 15_000\)/, 'read back as an mp4, never assumed');
  assert.ok(lib.indexOf('if (alreadyThere && uploadedNothingHere) {') < lib.indexOf('const completion = completionBody(tx, uploaded);'), 'looked for BEFORE asking again');
  // The state is not reset on a timeout: only an explicit refusal resets it.
  const block = lib.slice(lib.indexOf('// 4. COMPLETION.'), lib.indexOf('const finished = readCompletedTransaction(doneText);'));
  assert.equal((block.match(/resetUploadState/g) || []).length, 1, 'one reset, on a refusal, none on a timeout');
});

test('the copy maker tries the upload only when the bucket would not take the file', () => {
  const lib = src('lib/media-library.ts');
  assert.match(lib, /available: !staged\.ok && directUploadPossible\(sizeBytes\)/);
  assert.match(lib, /uploadVideoToMetricool\(fileId, title, \{ blogId: who\?\.blogId, budgetMs: who\?\.budgetMs \}\)/, 'for the brand the post is for, on the caller’s clock');
  assert.match(lib, /where: 'metricool'/, 'and records where the bytes went');
  // A failed upload is a NOTE on the refusal, never a thrown error.
  assert.match(lib, /directUpload = \{ available: false, note: direct\.message \}/);
});

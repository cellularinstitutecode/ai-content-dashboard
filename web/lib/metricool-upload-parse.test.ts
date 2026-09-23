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
  readOpenedTransaction,
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
  assert.match(lib, /export const DIRECT_UPLOAD_MAX_BYTES = 2 \* 1024 \* 1024 \* 1024/, 'the route’s ceiling is time, not storage');
  assert.match(lib, /const streamed = sizeBytes != null && sizeBytes > DIRECT_UPLOAD_STAGE_BYTES/, 'streamed only above the disk, and only with a known size');
  assert.match(lib, /await declarePartsFromDrive\(id, sizeBytes/, 'one pass to hash');
  assert.match(lib, /await partFromDrive\(id, start, end, contentType/, 'then each slice by Range request');
  assert.match(lib, /range: 'bytes=' \+ startByte \+ '-' \+ \(endByte - 1\)/, 'an inclusive HTTP range');
  assert.match(lib, /if \(total !== size\) throw new Error\('The download stopped at/, 'the byte count is checked, as on disk');
  assert.match(lib, /'content-length': String\(input\.bytes\)/, 'a whole-file PUT names its length');
  // The staged path is untouched: same download, same hashing, same order.
  assert.match(lib, /await declareParts\(tmp, bytes\)/);
});

test('the copy maker tries the upload only when the bucket would not take the file', () => {
  const lib = src('lib/media-library.ts');
  assert.match(lib, /available: !staged\.ok && directUploadPossible\(sizeBytes\)/);
  assert.match(lib, /uploadVideoToMetricool\(fileId, title, \{ blogId: who\?\.blogId \}\)/, 'for the brand the post is for');
  assert.match(lib, /where: 'metricool'/, 'and records where the bytes went');
  // A failed upload is a NOTE on the refusal, never a thrown error.
  assert.match(lib, /directUpload = \{ available: false, note: direct\.message \}/);
});

// web/lib/metricool-upload.ts
// Put the video INTO Metricool, instead of asking Metricool to come and get it.
//
// WHAT WAS WRONG WITH EVERY ROUTE BEFORE THIS ONE. They all ended the same
// way: a URL, handed to /actions/normalize/image/url, with Metricool asked to
// pull the file across. A Supabase URL works and the project's plan caps it at
// 50 MB. A Drive link is handed straight back — Metricool does not fetch from
// Drive, whatever the size, which row 191 proved on 21 September. This app's
// own streaming link is served by a Vercel function that cannot deliver a
// whole reel. So the clinic's 96 MB-1.8 GB videos had no route at all from
// this deployment, and the honest answer was a refusal naming two things to
// buy.
//
// Metricool's own media library does not pull from a link either. It asks the
// API for an upload transaction — PUT /v2/media/s3/upload-transactions — is
// handed pre-signed S3 addresses, and PUTs the bytes there. That is what this
// does: the file is streamed out of Drive with the service account that
// already reads them, staged on the scratch disk so it can be hashed and its
// length known, and pushed to the address Metricool named. The result is a
// file on storage Metricool trusts, which its own clients send in `media`
// without a normalise step at all.
//
// WHAT THE FIRST SENDS TAUGHT, AND WHAT ENDED THE GUESSING.
//
//   #297  "Metricool answered 400" — so the endpoint EXISTS and refused the body.
//   #300  The body, shown: {"resourceType":"Resource type is required",
//         "parts":"Parts list is required"}.
//   #301  resourceType and parts sent under every spelling this code could
//         think of. Every send: 400 · 400 · 400 · 500, the 500 being Jackson
//         unable to build an `S3UploadPart` from a bare number. Guessing an
//         undocumented body one refusal at a time was never going to land.
//   21 Sep The protocol was CAPTURED from Metricool's web app saving a post
//         with a video, and read against the uploader's own source. It is
//         written out at the foot of lib/metricool-upload-parse.ts and sent
//         here word for word: a file declared in 25 MB slices with a base64
//         SHA-256 each, under resourceType "planner"; one PUT per signed
//         address with x-amz-checksum-sha256; a PATCH that completes it; and
//         the converted copy on static.metricool.com goes into the post.
//
// Never throws. A failure here is one more route that did not work, and the
// caller has the older routes — and the refusal — to fall back on.
import 'server-only';

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { driveMediaStream, probeDriveMedia } from '@/lib/google-sources';
import { DISK_SAFE_BYTES } from '@/lib/media-route';
import { metricoolConfigured, metricoolFetch } from '@/lib/metricool';
import {
  bareEtag,
  completionBody,
  directUploadEnabled,
  isMetricoolHostedUrl,
  metricoolCopyId,
  partRanges,
  readCompletedTransaction,
  readOpenedTransaction,
  transactionBody,
  type DeclaredPart,
  type OpenedTransaction,
  type UploadedPart,
} from '@/lib/metricool-upload-parse';
import { redact, reportError } from '@/lib/report';

export { directUploadEnabled, isMetricoolHostedUrl, isMetricoolCopyId, metricoolCopyId } from '@/lib/metricool-upload-parse';

/**
 * The largest video this route carries.
 *
 * The file is staged on the function's scratch disk so it can be hashed and
 * the upload can name its length — S3 refuses a pre-signed PUT of unknown
 * length — and that disk is 512 MB shared with everything else the function
 * does. Same ceiling as the audio pipeline, for the same reason.
 */
export const DIRECT_UPLOAD_MAX_BYTES = DISK_SAFE_BYTES;

const TRANSACTIONS_PATH = '/v2/media/s3/upload-transactions';
/** One small JSON call; it should not take long. */
const CALL_MS = 30_000;
/** What the whole route may spend, inside a 300-second function. */
const DEFAULT_BUDGET_MS = 270_000;
/** Multipart parts in flight at once. File-backed blobs, so memory is not the limit; the pipe is. */
const PART_CONCURRENCY = 4;

export type DirectUpload =
  | { ok: true; url: string; copyId: string; bytes: number; sizeBytes: number | null }
  | {
      ok: false;
      reason: 'off' | 'unconfigured' | 'too_large' | 'unreachable' | 'refused' | 'unreadable' | 'failed';
      message: string;
      status?: number | null;
      shape?: string;
      sizeBytes?: number | null;
    };

/** Can this route even be attempted for a file of this size? */
export function directUploadPossible(sizeBytes: number | null | undefined): boolean {
  if (!directUploadEnabled() || !metricoolConfigured()) return false;
  const n = Number(sizeBytes);
  return !(Number.isFinite(n) && n > 0) || n <= DIRECT_UPLOAD_MAX_BYTES;
}

function mb(bytes: number): string {
  return Math.round(bytes / 1024 / 1024) + ' MB';
}

/** A refusal body as one short, redacted line for the screen. */
function said(text: string): string {
  return redact(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Base64 SHA-256 of one byte range of a file — what each declared part carries, and what S3 checks the PUT against. */
async function sha256Base64(path: string, startByte: number, endByte: number): Promise<string> {
  const hash = createHash('sha256');
  if (endByte > startByte) {
    await pipeline(createReadStream(path, { start: startByte, end: endByte - 1 }), hash);
  }
  return hash.digest('base64');
}

/** The file declared the way Metricool's uploader declares it: 25 MB slices, each hashed. */
async function declareParts(path: string, bytes: number): Promise<DeclaredPart[]> {
  const out: DeclaredPart[] = [];
  for (const r of partRanges(bytes)) {
    out.push({ ...r, hash: await sha256Base64(path, r.startByte, r.endByte) });
  }
  return out;
}

type Opened = { tx: OpenedTransaction; status: number };
type NotOpened = { tx: null; status: number | null; detail: string };

/** Step 1: open the transaction. One call, one body — the one the web app sends. */
async function openTransaction(
  input: { contentType: string; bytes: number; parts: DeclaredPart[]; blogId?: string | null; left: () => number },
): Promise<Opened | NotOpened> {
  const body = transactionBody({ contentType: input.contentType, size: input.bytes, parts: input.parts });
  const res = await metricoolFetch(TRANSACTIONS_PATH, {
    method: 'PUT',
    body: JSON.stringify(body),
    timeoutMs: Math.min(CALL_MS, Math.max(5_000, input.left())),
    blogId: input.blogId,
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = said(text);
    console.warn('metricool:upload-transaction non-ok', res.status, input.parts.length, 'parts', detail.slice(0, 200));
    return { tx: null, status: res.status, detail };
  }
  const tx = readOpenedTransaction(text);
  console.info('metricool:upload-transaction opened', tx.uploadType, tx.shape, 'parts', tx.parts.length, 'uploadId', Boolean(tx.uploadId));
  return { tx, status: res.status };
}

/**
 * Step 2, one part: PUT a byte range to its signed address.
 *
 * The content type and the checksum are sent exactly as the web app sends
 * them — both may be part of what was signed. The reply's ETag is what a
 * multipart completion is made of.
 */
async function putPart(
  input: { url: string; blob: Blob; contentType: string; hash: string; left: () => number },
): Promise<{ ok: true; etag: string | null } | { ok: false; status: number; detail: string }> {
  const up = await fetch(input.url, {
    method: 'PUT',
    body: input.blob,
    headers: { 'content-type': input.contentType, 'x-amz-checksum-sha256': input.hash },
    signal: AbortSignal.timeout(Math.max(5_000, input.left() - 5_000)),
  });
  if (!up.ok) {
    const detail = said(await up.text().catch(() => ''));
    return { ok: false, status: up.status, detail };
  }
  const etag = bareEtag(up.headers.get('etag'));
  await up.text().catch(() => '');
  return { ok: true, etag };
}

/** A few at a time, in order of submission; the first failure stops the rest. */
async function inBatches<T, R>(items: T[], size: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const done = await Promise.all(batch.map((item, j) => run(item, i + j)));
    out.push(...done);
  }
  return out;
}

/**
 * Upload one Drive video into Metricool's storage and answer with its address.
 *
 * `name` is kept for the callers that pass it; the transaction does not take a
 * filename — Metricool names the object itself, under the brand's planner
 * folder for the month.
 */
export async function uploadVideoToMetricool(
  fileId: string,
  name?: string | null,
  /** `blogId`: the brand the post is for, so the file lands in that brand's library. */
  opts: { budgetMs?: number; blogId?: string | null } = {},
): Promise<DirectUpload> {
  void name;
  const id = String(fileId || '').trim();
  if (!id) return { ok: false, reason: 'failed', message: 'No video id.' };
  if (!directUploadEnabled()) return { ok: false, reason: 'off', message: 'Direct upload to Metricool is switched off (METRICOOL_DIRECT_UPLOAD).' };
  if (!metricoolConfigured()) return { ok: false, reason: 'unconfigured', message: 'Metricool is not configured, so nothing can be uploaded to it.' };

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const left = () => deadline - Date.now();

  const probe = await probeDriveMedia(id, Number.POSITIVE_INFINITY);
  if (!probe.ok) {
    return { ok: false, reason: probe.reason === 'not_media' ? 'failed' : 'unreachable', message: probe.message, sizeBytes: probe.sizeBytes ?? null };
  }
  const sizeBytes = typeof probe.sizeBytes === 'number' && Number.isFinite(probe.sizeBytes) ? probe.sizeBytes : null;
  if (sizeBytes != null && sizeBytes > DIRECT_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      sizeBytes,
      message: mb(sizeBytes) + ' is more than the ' + mb(DIRECT_UPLOAD_MAX_BYTES) + ' this function can stage for an upload.',
    };
  }
  const contentType = 'video/mp4';

  let dir: string | null = null;
  try {
    // 1. THE BYTES, out of Drive and onto the scratch disk. First, because the
    // transaction declares each slice's checksum, and a checksum needs the bytes.
    if (left() < 20_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to move the video.' };
    dir = await mkdtemp(join(tmpdir(), 'chi-upload-'));
    const tmp = join(dir, id + '.mp4');
    const res = await driveMediaStream(id, Math.min(240_000, left() - 15_000));
    if (!res.ok || !res.body) {
      return { ok: false, reason: 'unreachable', sizeBytes, message: 'Drive answered HTTP ' + res.status + ' to the download.' };
    }
    await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), createWriteStream(tmp));
    const bytes = (await stat(tmp)).size;
    if (sizeBytes != null && bytes !== sizeBytes) {
      return { ok: false, reason: 'failed', sizeBytes, message: 'The download stopped at ' + bytes.toLocaleString() + ' of ' + sizeBytes.toLocaleString() + ' bytes.' };
    }
    if (bytes <= 0) return { ok: false, reason: 'failed', sizeBytes, message: 'Drive handed over an empty file.' };
    if (bytes > DIRECT_UPLOAD_MAX_BYTES) {
      return { ok: false, reason: 'too_large', sizeBytes: bytes, message: mb(bytes) + ' is more than the ' + mb(DIRECT_UPLOAD_MAX_BYTES) + ' this function can stage for an upload.' };
    }

    // 2. THE TRANSACTION. The file declared in slices, each with its hash;
    // Metricool names where each slice goes.
    const declared = await declareParts(tmp, bytes);
    if (left() < 20_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to open the upload.' };
    let opened: Opened | NotOpened;
    try {
      opened = await openTransaction({ contentType, bytes, parts: declared, blogId: opts.blogId, left });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reportError('metricool-upload:transaction', e, { fileId: id });
      return { ok: false, reason: 'unreachable', sizeBytes, message: 'Metricool could not be reached to open an upload: ' + message };
    }
    if (!opened.tx) {
      const status = opened.status ?? 0;
      return {
        ok: false,
        reason: status >= 500 ? 'unreachable' : 'refused',
        status: opened.status,
        sizeBytes,
        message: 'Metricool answered ' + status + ' when asked to open an upload' +
          (status === 404 ? ' — no such endpoint on this account' : '') +
          (opened.detail ? '. It said: ' + opened.detail : '.'),
      };
    }
    const tx = opened.tx;
    const unreadable = (what: string): DirectUpload => {
      // The one failure whose fix is a key name. Types only: the reply may
      // carry a credential, and the shape is the diagnosis.
      console.warn('metricool:upload-transaction unreadable', opened.status, tx.shape, what);
      return {
        ok: false, reason: 'unreadable', status: opened.status, shape: tx.shape, sizeBytes,
        message: 'Metricool opened an upload but this app could not find ' + what + ' in its answer (it replied with ' + tx.shape + ').',
      };
    };

    // 3. THE UPLOAD, to the address(es) Metricool named. openAsBlob hands fetch
    // a body with a known length without reading the file into memory, and a
    // slice of it is still file-backed.
    if (left() < 10_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to upload the video.' };
    const whole = await openAsBlob(tmp, { type: contentType });
    const uploaded: UploadedPart[] = [];
    if (tx.uploadType === 'MULTIPART') {
      if (!tx.uploadId || !tx.key) return unreadable('the multipart upload id and key');
      if (!tx.parts.length) return unreadable('a signed address per part');
      if (tx.parts.length !== declared.length) {
        console.warn('metricool:upload-transaction signed', tx.parts.length, 'parts for', declared.length, 'declared');
      }
      const results = await inBatches(tx.parts, PART_CONCURRENCY, async (part) => {
        // The range and the checksum are the declared part's, by number — the
        // web app pairs them by position, and a reply that renumbers them would
        // fail S3's checksum rather than send the wrong bytes quietly.
        const mine = declared[part.partNumber - 1];
        if (!mine) return { ok: false as const, status: 0, detail: 'part ' + part.partNumber + ' was signed but never declared', partNumber: part.partNumber };
        const start = part.startByte ?? mine.startByte;
        const end = part.endByte ?? mine.endByte;
        const r = await putPart({ url: part.presignedUrl, blob: whole.slice(start, end, contentType), contentType, hash: mine.hash, left });
        return { ...r, partNumber: part.partNumber };
      });
      for (const r of results) {
        if (!r.ok) {
          console.warn('metricool:upload part non-ok', r.partNumber, r.status, r.detail);
          return {
            ok: false, reason: r.status >= 500 ? 'unreachable' : 'refused', status: r.status || null, sizeBytes,
            message: 'Metricool opened a multipart upload (' + tx.parts.length + ' parts) but part ' + r.partNumber + ' was refused by the storage it named' +
              (r.status ? ' (' + r.status + ')' : '') + (r.detail ? ': ' + r.detail : '.'),
          };
        }
        if (!r.etag) {
          return { ok: false, reason: 'unreadable', sizeBytes, message: 'Part ' + r.partNumber + ' went up but the storage returned no ETag, and the completion is made of ETags.' };
        }
        uploaded.push({ partNumber: r.partNumber, etag: r.etag });
      }
    } else {
      // SIMPLE — or a type this code does not know, sent the simple way and
      // reported by name if it is wrong. The checksum is the whole file's: for
      // one declared part that is the part's hash, and for more it is what an
      // S3 PUT of the whole object actually checks.
      if (!tx.presignedUrl) return unreadable('a signed upload address');
      if (tx.uploadType !== 'SIMPLE') console.warn('metricool:upload-transaction unknown type, sent as SIMPLE', tx.uploadType);
      const hash = declared.length === 1 ? declared[0].hash : await sha256Base64(tmp, 0, bytes);
      const r = await putPart({ url: tx.presignedUrl, blob: whole, contentType, hash, left });
      if (!r.ok) {
        console.warn('metricool:upload non-ok', r.status, r.detail);
        return {
          ok: false, reason: r.status >= 500 ? 'unreachable' : 'refused', status: r.status, sizeBytes,
          message: 'Metricool opened the upload (it replied with ' + tx.shape + ') but the storage it named refused the bytes (' + r.status + ')' +
            (r.detail ? ': ' + r.detail : '.'),
        };
      }
    }
    console.info('metricool:upload done', bytes, 'bytes', tx.uploadType, uploaded.length || 1, 'part(s)');

    // 4. COMPLETION. Neither kind is a file Metricool knows about until the
    // transaction is completed: a multipart upload is not even an object, and a
    // simple one is not converted onto static.metricool.com.
    if (left() < 5_000) return { ok: false, reason: 'failed', sizeBytes, message: 'The bytes went up but there was no time left to complete the upload.' };
    const completion = completionBody(tx, uploaded);
    const done = await metricoolFetch(TRANSACTIONS_PATH, {
      method: 'PATCH',
      body: JSON.stringify(completion),
      timeoutMs: Math.min(CALL_MS, Math.max(5_000, left())),
      blogId: opts.blogId,
    });
    const doneText = await done.text();
    if (!done.ok) {
      const detail = said(doneText);
      console.warn('metricool:upload-complete non-ok', done.status, detail.slice(0, 160));
      return {
        ok: false,
        reason: done.status >= 500 ? 'unreachable' : 'refused',
        status: done.status,
        shape: tx.shape,
        sizeBytes,
        message: 'The bytes went up (' + mb(bytes) + ', ' + (tx.uploadType || 'simple').toLowerCase() + ') but Metricool answered ' + done.status +
          ' to completing the upload, so it has no file yet' + (detail ? '. It said: ' + detail : '.'),
      };
    }
    const finished = readCompletedTransaction(doneText);
    // The converted copy is what the web app puts in a post; the raw object on
    // the temp bucket is the fallback, and it is Metricool-hosted too.
    const fileUrl = finished.convertedFileUrl || finished.fileUrl || tx.fileUrl;
    if (!fileUrl) {
      return {
        ok: false,
        reason: 'unreadable',
        shape: finished.shape,
        sizeBytes,
        message: 'The bytes went up (' + mb(bytes) + ') and the upload completed, but the completion named no file address (it replied with ' + finished.shape + ').',
      };
    }
    if (!isMetricoolHostedUrl(fileUrl)) {
      // Recorded so the trusted-host list can be widened by one line, not sent:
      // a file address on a host Metricool does not trust is a normalise that
      // will echo, which is the failure this route exists to end.
      console.warn('metricool:upload unfamiliar host', fileUrl.slice(0, 120));
    }
    console.info('metricool:upload complete', finished.convertedFileUrl ? 'converted' : 'raw', finished.shape);
    return { ok: true, url: fileUrl, copyId: metricoolCopyId(finished.key || tx.key || new URL(fileUrl).pathname), bytes, sizeBytes };
  } catch (e) {
    reportError('metricool-upload:transfer', e, { fileId: id });
    const aborted = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false,
      reason: aborted ? 'unreachable' : 'failed',
      sizeBytes,
      message: aborted ? 'Moving the video into Metricool ran out of time.' : (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

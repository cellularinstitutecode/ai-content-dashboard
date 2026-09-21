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
// already reads them, staged on the scratch disk so its length is known, and
// pushed to the address Metricool named. The result is a file on storage
// Metricool trusts, which its own clients send in `media` without a normalise
// step at all.
//
// WHAT THE FIRST SENDS TAUGHT. The public docs do not describe this endpoint,
// so it was written blind and each real send has bought one fact:
//
//   #297  "Metricool answered 400" — so the endpoint EXISTS (not the 404 the
//         code was braced for) and refused the body.
//   #300  The body, shown: {"title":"ValidationError","detail":{"resourceType":
//         "Resource type is required","parts":"Parts list is required"}} and,
//         with a folder named, "At least one part is required".
//
// So the transaction is a MULTIPART one: it wants a resource type and a list
// of parts, and hands back (this is the expectation) one signed address per
// part, plus S3's upload id — which means the upload must be COMPLETED after
// the parts are in, or the object never exists. The remaining unknowns are
// the enum's spelling, the part descriptor's shape, and the completion call.
// Each is asked in the most likely way first, the refusal is read for what it
// says (a Java backend names the accepted enum values and the field it could
// not read), and every answer reaches the screen in types — so the next send
// is a fact and not another guess.
//
// Never throws. A failure here is one more route that did not work, and the
// caller has the older routes — and the refusal — to fall back on.
import 'server-only';

import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { driveMediaStream, probeDriveMedia } from '@/lib/google-sources';
import { DISK_SAFE_BYTES } from '@/lib/media-route';
import { metricoolConfigured, metricoolFetch } from '@/lib/metricool';
import {
  acceptedValues,
  directUploadEnabled,
  isMetricoolHostedUrl,
  metricoolCopyId,
  readUploadTransaction,
  refusedFields,
  type UploadTransaction,
} from '@/lib/metricool-upload-parse';
import { redact, reportError } from '@/lib/report';

export { directUploadEnabled, isMetricoolHostedUrl, isMetricoolCopyId, metricoolCopyId } from '@/lib/metricool-upload-parse';

/**
 * The largest video this route carries.
 *
 * The file is staged on the function's scratch disk so the upload can name
 * its length — S3 refuses a pre-signed PUT of unknown length — and that disk
 * is 512 MB shared with everything else the function does. Same ceiling as
 * the audio pipeline, for the same reason.
 */
export const DIRECT_UPLOAD_MAX_BYTES = DISK_SAFE_BYTES;

const TRANSACTIONS_PATH = '/v2/media/s3/upload-transactions';
/** One small JSON call; it should not take long. */
const CALL_MS = 30_000;
/** What the whole route may spend, inside a 300-second function. */
const DEFAULT_BUDGET_MS = 270_000;
/** Small calls that move no bytes: how many to spend on the transaction and on completing it. */
const MAX_OPEN_CALLS = 6;
const MAX_COMPLETE_CALLS = 5;

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

/**
 * Ours first, theirs on top — by name, case-insensitively.
 *
 * Header names are case-insensitive and a Headers object built from a plain
 * record is not: 'content-type' and 'Content-Type' both survive and are sent
 * joined with a comma, which no signature matches.
 */
function mergeHeaders(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    out[k] = v;
  }
  return out;
}

type Opened = { tx: UploadTransaction; status: number; tried: string[] };
type NotOpened = { tx: null; status: number | null; tried: string[]; detail: string; shape?: string };

/**
 * Open the transaction, learning from each refusal.
 *
 * The body carries the two fields Metricool asked for by name — resourceType
 * and parts — alongside the file's name, type and size under every spelling
 * (a Java backend ignores the ones it does not know). Two things are still
 * guessed and corrected from the answer: the enum's value, which a wrong
 * guess gets listed back ("accepted for Enum class: [...]"), and whether a
 * part is an object or a bare number, which a wrong guess gets named back as
 * the field it could not read.
 */
async function openTransaction(
  input: { filename: string; contentType: string; sizeBytes: number | null; blogId?: string | null; left: () => number },
): Promise<Opened | NotOpened> {
  const { filename, contentType, sizeBytes } = input;
  const enumGuesses = ['VIDEO', 'video', 'MEDIA', 'FILE'];
  const partObject = {
    partNumber: 1, number: 1,
    ...(sizeBytes != null ? { size: sizeBytes, contentLength: sizeBytes, length: sizeBytes } : {}),
    contentType, filename, fileName: filename, name: filename,
  };
  const partShapes: unknown[][] = [[partObject], [1]];
  const bodyFor = (resourceType: string, parts: unknown[]) => ({
    resourceType,
    type: resourceType,
    parts,
    filename, fileName: filename, name: filename,
    contentType, mimeType: contentType,
    ...(sizeBytes != null ? { size: sizeBytes, fileSize: sizeBytes, contentLength: sizeBytes, totalSize: sizeBytes } : {}),
    partCount: parts.length, numberOfParts: parts.length,
  });

  const tried: string[] = [];
  let detail = '';
  let lastStatus: number | null = null;
  let enumIdx = 0;
  let shapeIdx = 0;
  let learnedEnum: string | null = null;
  for (let call = 0; call < MAX_OPEN_CALLS; call++) {
    if (input.left() < 20_000) break;
    const resourceType = learnedEnum || enumGuesses[Math.min(enumIdx, enumGuesses.length - 1)];
    const parts = partShapes[Math.min(shapeIdx, partShapes.length - 1)];
    const res = await metricoolFetch(TRANSACTIONS_PATH, {
      method: 'PUT',
      body: JSON.stringify(bodyFor(resourceType, parts)),
      timeoutMs: Math.min(CALL_MS, Math.max(5_000, input.left())),
      blogId: input.blogId,
    });
    const text = await res.text();
    lastStatus = res.status;
    tried.push(String(res.status));
    if (res.ok) {
      const tx = readUploadTransaction(text);
      console.info('metricool:upload-transaction opened', tx.shape, 'parts', tx.parts.length, 'uploadId', Boolean(tx.uploadId));
      return { tx, status: res.status, tried };
    }
    detail = said(text);
    console.warn('metricool:upload-transaction non-ok', res.status, resourceType, JSON.stringify(parts).slice(0, 60), detail.slice(0, 200));
    if (res.status !== 400 && res.status !== 422) break;

    // READ THE REFUSAL. An enum list is the value to send; a complaint that
    // names `parts` (or a Jackson "cannot deserialize" about it) is the other
    // shape; a complaint about neither is not one more spelling will fix.
    const accepted = acceptedValues(text);
    const fields = refusedFields(text);
    const lower = text.toLowerCase();
    if (accepted.length && !learnedEnum) {
      learnedEnum = accepted.find((v) => /video/i.test(v)) || accepted.find((v) => /media|file/i.test(v)) || accepted[0];
      continue;
    }
    if (/resourcetype/.test(lower) && !fields.includes('parts') && enumIdx < enumGuesses.length - 1 && !learnedEnum) {
      enumIdx++;
      continue;
    }
    if ((fields.includes('parts') || /parts/.test(lower)) && shapeIdx < partShapes.length - 1) {
      shapeIdx++;
      continue;
    }
    if (enumIdx < enumGuesses.length - 1 && !learnedEnum) { enumIdx++; continue; }
    break;
  }
  return { tx: null, status: lastStatus, tried, detail };
}

/**
 * Complete a multipart upload, asking the likeliest doors in turn.
 *
 * S3 does not have the object until the multipart upload is completed with
 * the parts' ETags, and Metricool's own door for that is not documented. The
 * transaction's reply is read first for a completion address of its own; then
 * the conventional spellings under the transaction's path. A 404 or 405 is
 * "not this door"; a 400 is "this door, other words", and its text is kept.
 */
async function completeUpload(
  input: { tx: UploadTransaction; etag: string | null; bytes: number; blogId?: string | null; left: () => number },
): Promise<{ ok: true; status: number; text: string; tried: string[] } | { ok: false; tried: string[]; detail: string; status: number | null }> {
  const { tx, etag } = input;
  const ref = tx.id || tx.uploadId || tx.key || '';
  const part = { partNumber: 1, number: 1, eTag: etag, etag, ETag: etag, size: input.bytes };
  const body = {
    parts: [part],
    ...(tx.uploadId ? { uploadId: tx.uploadId } : {}),
    ...(tx.key ? { key: tx.key } : {}),
    ...(tx.id ? { id: tx.id, transactionId: tx.id } : {}),
  };
  const doors: { path: string; method: 'POST' | 'PUT' | 'PATCH' }[] = [];
  const enc = encodeURIComponent(ref);
  if (ref) {
    doors.push({ path: TRANSACTIONS_PATH + '/' + enc + '/complete', method: 'POST' });
    doors.push({ path: TRANSACTIONS_PATH + '/' + enc, method: 'POST' });
    doors.push({ path: TRANSACTIONS_PATH + '/' + enc, method: 'PUT' });
    doors.push({ path: TRANSACTIONS_PATH + '/' + enc + '/completion', method: 'POST' });
  }
  doors.push({ path: TRANSACTIONS_PATH + '/complete', method: 'POST' });
  doors.push({ path: TRANSACTIONS_PATH + '/completions', method: 'POST' });

  const tried: string[] = [];
  let detail = '';
  let lastStatus: number | null = null;
  for (const door of doors.slice(0, MAX_COMPLETE_CALLS)) {
    if (input.left() < 10_000) break;
    const res = await metricoolFetch(door.path, {
      method: door.method,
      body: JSON.stringify(body),
      timeoutMs: Math.min(CALL_MS, Math.max(5_000, input.left())),
      blogId: input.blogId,
    });
    const text = await res.text();
    lastStatus = res.status;
    tried.push(door.method + ' ' + door.path.replace(TRANSACTIONS_PATH, '…').replace(enc, '{id}') + ' ' + res.status);
    if (res.ok) {
      console.info('metricool:upload-complete via', door.method, door.path);
      return { ok: true, status: res.status, text, tried };
    }
    if (res.status === 400 || res.status === 422 || res.status === 409) detail = said(text);
    console.warn('metricool:upload-complete non-ok', door.method, door.path, res.status, said(text).slice(0, 160));
    // A door that is not there costs nothing; a server error is not "try the next spelling".
    if (res.status >= 500) break;
  }
  return { ok: false, tried, detail, status: lastStatus };
}

/**
 * Upload one Drive video into Metricool's storage and answer with its address.
 *
 * `name` is the filename Metricool is told; it shows in their media library.
 */
export async function uploadVideoToMetricool(
  fileId: string,
  name?: string | null,
  /** `blogId`: the brand the post is for, so the file lands in that brand's library. */
  opts: { budgetMs?: number; blogId?: string | null } = {},
): Promise<DirectUpload> {
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

  // 1. THE TRANSACTION. Metricool names where the bytes go.
  const filename = (String(name || probe.name || 'video').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\.(mp4|mov|m4v)$/i, '').slice(0, 80) || 'video') + '.mp4';
  const contentType = 'video/mp4';
  let opened: Opened | NotOpened;
  try {
    opened = await openTransaction({ filename, contentType, sizeBytes, blogId: opts.blogId, left });
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
        (opened.tried.length > 1 ? ' (' + opened.tried.join(' · ') + ' across ' + opened.tried.length + ' spellings of the request)' : '') +
        (opened.detail ? '. It said: ' + opened.detail : '.'),
    };
  }
  const tx = opened.tx;
  if (!tx.uploadUrl) {
    // The one failure whose fix is a key name. Types only: the reply may
    // carry a credential, and the shape is the diagnosis.
    console.warn('metricool:upload-transaction unreadable', opened.status, tx.shape);
    return {
      ok: false,
      reason: 'unreadable',
      status: opened.status,
      shape: tx.shape,
      sizeBytes,
      message: 'Metricool opened an upload but this app could not find a signed upload address in its answer (it replied with ' + tx.shape + ').',
    };
  }
  if (tx.parts.length > 1) {
    // The whole file goes up as ONE part. If Metricool signed several because
    // we declared one, something is being read wrongly; better to say so.
    console.warn('metricool:upload-transaction signed', tx.parts.length, 'parts for one declared');
  }

  // 2. THE BYTES, out of Drive and onto the scratch disk.
  let dir: string | null = null;
  try {
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

    // 3. THE UPLOAD, to the address Metricool named. openAsBlob hands fetch a
    // body with a known length without reading the file into memory.
    if (left() < 10_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to upload the video.' };
    const blob = await openAsBlob(tmp, { type: contentType });
    let up: Response;
    if (tx.method === 'POST' && tx.fields) {
      const form = new FormData();
      for (const [k, v] of Object.entries(tx.fields)) form.append(k, v);
      form.append('file', blob, filename);
      up = await fetch(tx.uploadUrl, { method: 'POST', body: form, headers: tx.headers, signal: AbortSignal.timeout(left() - 5_000) });
    } else {
      // The content type is part of what was signed, so it is sent exactly as
      // it was asked for; a header the reply named wins over it.
      up = await fetch(tx.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: mergeHeaders({ 'content-type': contentType }, tx.headers),
        signal: AbortSignal.timeout(left() - 5_000),
      });
    }
    if (!up.ok) {
      const detail = said(await up.text().catch(() => ''));
      console.warn('metricool:upload non-ok', up.status, detail);
      return {
        ok: false,
        reason: 'refused',
        status: up.status,
        sizeBytes,
        message: 'Metricool opened the upload (it replied with ' + tx.shape + ') but the storage it named refused the bytes (' + up.status + ')' +
          (detail ? ': ' + detail : '.'),
      };
    }
    const etag = (up.headers.get('etag') || '').trim() || null;
    await up.text().catch(() => '');
    console.info('metricool:upload done', bytes, 'bytes', 'etag', Boolean(etag));

    // 4. COMPLETION. A multipart upload is not an object until it is completed;
    // a plain pre-signed PUT already is. The reply said which by naming an
    // upload id — or not.
    const multipart = Boolean(tx.uploadId) || /[?&](uploadId|partNumber)=/i.test(tx.uploadUrl);
    let fileUrl = tx.fileUrl;
    const done = await completeUpload({ tx, etag, bytes, blogId: opts.blogId, left });
    if (done.ok) {
      const after = readUploadTransaction(done.text);
      if (after.fileUrl && isMetricoolHostedUrl(after.fileUrl)) fileUrl = after.fileUrl;
      else if (!fileUrl && after.fileUrl) fileUrl = after.fileUrl;
    } else if (multipart) {
      return {
        ok: false,
        reason: 'refused',
        status: done.status,
        shape: tx.shape,
        sizeBytes,
        message: 'The bytes went up (' + mb(bytes) + ', part 1 accepted' + (etag ? ' with an ETag' : ', no ETag returned') +
          ') but the multipart upload could not be completed, so Metricool has no file yet. The transaction replied with ' + tx.shape +
          '. Completion tried: ' + done.tried.join(' · ') + (done.detail ? '. It said: ' + done.detail : '.'),
      };
    } else {
      console.warn('metricool:upload-complete not found, single PUT taken as complete', done.tried.join(' · '));
    }

    if (!fileUrl) {
      return {
        ok: false,
        reason: 'unreadable',
        shape: tx.shape,
        sizeBytes,
        message: 'The bytes went up (' + mb(bytes) + ') but neither the transaction nor its completion named the file’s address. The transaction replied with ' +
          tx.shape + (done.ok ? '; completion replied with ' + readUploadTransaction(done.text).shape : '') + '.',
      };
    }
    if (!isMetricoolHostedUrl(fileUrl)) {
      // Recorded so the trusted-host list can be widened by one line, not sent:
      // a file address on a host Metricool does not trust is a normalise that
      // will echo, which is the failure this route exists to end.
      console.warn('metricool:upload unfamiliar host', fileUrl.slice(0, 120));
    }
    return { ok: true, url: fileUrl, copyId: metricoolCopyId(tx.key || tx.id || new URL(fileUrl).pathname), bytes, sizeBytes };
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

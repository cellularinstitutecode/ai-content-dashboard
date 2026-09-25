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
import { request as httpsRequest } from 'node:https';
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
import {
  claimUpload, finishUploadState, loadUploadState, releaseUpload, resetUploadState, saveHashingProgress, saveUploadEtags, saveUploadState,
} from '@/lib/metricool-upload-state';

export { directUploadEnabled, isMetricoolHostedUrl, isMetricoolCopyId, metricoolCopyId } from '@/lib/metricool-upload-parse';

/**
 * The largest video that is STAGED on the scratch disk first.
 *
 * Up to here the file is written to the function's /tmp so it can be hashed
 * and sliced from one place — the proven path, the one the 149 MB reels went
 * out on. That disk is 512 MB shared with everything else the function does,
 * so this is the audio pipeline's ceiling, for the same reason.
 */
export const DIRECT_UPLOAD_STAGE_BYTES = DISK_SAFE_BYTES;

/**
 * The largest video this route carries at all.
 *
 * Above the staging ceiling the disk is never used: the file is read out of
 * Drive once to hash its slices, the transaction is opened, and then each
 * 25 MB slice is fetched again by Range request and put to its signed address
 * — a slice or three in memory, nothing on disk. The 477 MB reel that was
 * refused as "more than this function can stage" is exactly the file this
 * exists for.
 *
 * AND IT RESUMES. Row 200 is 2785 MB, and no single 300-second request moves
 * that. A multipart upload is a list of slices, each its own PUT with its own
 * ETag, so what one request could not finish is written to
 * metricool_uploads (lib/metricool-upload-state.ts) — the hashes, the signed
 * addresses, every ETag so far — and the next pass (the 15-minute sweep, or a
 * person pressing again) carries on at the first slice without one. The one
 * thing that must fit in a single request is the hashing pass, one read of
 * the file; five gigabytes is where that stops being plausible.
 */
export const DIRECT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** How long signed addresses are trusted when the reply did not say. */
const DEFAULT_SIGNED_TTL_MS = 50 * 60_000;
/** Time kept back before starting another batch, so the ETags so far can be banked. */
const BATCH_RESERVE_MS = 30_000;

const TRANSACTIONS_PATH = '/v2/media/s3/upload-transactions';
/** One small JSON call; it should not take long. */
const CALL_MS = 30_000;
/** What the whole route may spend, inside a 300-second function. */
const DEFAULT_BUDGET_MS = 270_000;
/** Multipart parts in flight at once. File-backed blobs, so memory is not the limit; the pipe is. */
const PART_CONCURRENCY = 4;
/** The same, when each part is a 25 MB buffer fetched from Drive: three is 75 MB in flight. */
const STREAMED_PART_CONCURRENCY = 3;

export type DirectUpload =
  | { ok: true; url: string; copyId: string; bytes: number; sizeBytes: number | null }
  | {
      ok: false;
      /** `pending`: not failed — the slices so far are banked and the next pass continues. */
      reason: 'off' | 'unconfigured' | 'too_large' | 'unreachable' | 'refused' | 'unreadable' | 'failed' | 'pending';
      message: string;
      status?: number | null;
      shape?: string;
      sizeBytes?: number | null;
      /** For `pending`: slices in Metricool so far, and the total. */
      progress?: { done: number; total: number };
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

/**
 * The file declared from ONE pass over the Drive stream, with nothing kept.
 *
 * The transaction wants every slice's checksum before it opens, and a
 * checksum needs the bytes — but not the disk. Each chunk is fed to the
 * running slice hash (split where a chunk straddles a 25 MB boundary) and to
 * the whole-file hash, then dropped. The byte count is checked against what
 * Drive reported, exactly as the disk path checks it.
 */
async function declarePartsFromDrive(
  fileId: string, size: number, transferMs: number,
  /**
   * `declared`: slices already measured by an earlier request, so this one
   * starts at the next byte. `stopWhen`: asked after every slice; when true,
   * the pass stops there and reports `complete: false` with what it has.
   */
  opts: { declared?: DeclaredPart[]; stopWhen?: () => boolean } = {},
): Promise<{ declared: DeclaredPart[]; wholeHash: string | null; bytes: number; complete: boolean }> {
  const ranges = partRanges(size);
  const declared: DeclaredPart[] = [...(opts.declared || [])];
  const from = declared.reduce((n, p) => Math.max(n, p.endByte), 0);
  if (from >= size) return { declared, wholeHash: null, bytes: size, complete: true };
  const res = await driveMediaStream(fileId, transferMs, from > 0 ? { range: 'bytes=' + from + '-' } : {});
  if (!res.ok || !res.body) throw new Error('Drive answered HTTP ' + res.status + ' to the download.');
  // A 200 to a Range request is the whole file from byte zero; skip what is
  // already measured rather than measure it twice.
  let skip = from > 0 && res.status === 200 ? from : 0;
  // The whole-file hash only exists when this pass saw every byte.
  const whole = from === 0 ? createHash('sha256') : null;
  let part = createHash('sha256');
  let idx = declared.length;
  let inPart = 0;
  let total = from;
  let stopped = false;
  const body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  for await (const chunk of body) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (skip > 0) {
      const drop = Math.min(skip, buf.length);
      buf = buf.subarray(drop);
      skip -= drop;
      if (!buf.length) continue;
    }
    whole?.update(buf);
    total += buf.length;
    while (buf.length) {
      const r = ranges[idx];
      if (!r) throw new Error('Drive handed over more bytes than it reported (' + total.toLocaleString() + ' of ' + size.toLocaleString() + ').');
      const take = buf.subarray(0, Math.min(r.size - inPart, buf.length));
      part.update(take);
      inPart += take.length;
      buf = buf.subarray(take.length);
      if (inPart === r.size) {
        declared.push({ ...r, hash: part.digest('base64') });
        part = createHash('sha256');
        inPart = 0;
        idx++;
        if (idx < ranges.length && opts.stopWhen?.()) { stopped = true; break; }
      }
    }
    if (stopped) break;
  }
  if (stopped) {
    body.destroy();
    return { declared, wholeHash: null, bytes: total, complete: false };
  }
  if (total !== size) throw new Error('The download stopped at ' + total.toLocaleString() + ' of ' + size.toLocaleString() + ' bytes.');
  return { declared, wholeHash: whole ? whole.digest('base64') : null, bytes: total, complete: true };
}

/** One slice of the file, fetched from Drive by Range request, as a body of known length. */
async function partFromDrive(fileId: string, startByte: number, endByte: number, contentType: string, transferMs: number): Promise<Blob> {
  const res = await driveMediaStream(fileId, transferMs, { range: 'bytes=' + startByte + '-' + (endByte - 1) });
  if (!res.ok || !res.body) throw new Error('Drive answered HTTP ' + res.status + ' to a range request.');
  const all = Buffer.from(await res.arrayBuffer());
  // A 206 is the slice; a 200 is a server that ignored the Range and sent the
  // whole file, which is still the right bytes at the right offset.
  const bytes = res.status === 206 ? all : all.subarray(startByte, endByte);
  const want = endByte - startByte;
  if (bytes.length !== want) throw new Error('Drive handed over ' + bytes.length.toLocaleString() + ' bytes for a ' + want.toLocaleString() + '-byte slice.');
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: contentType });
}

/**
 * The whole file, piped from Drive to a signed address with its length named.
 *
 * Only for a SIMPLE transaction on a file too large to stage — which Metricool
 * is not expected to open for a file declared in twenty slices, but a reply is
 * read, not assumed. node:https rather than fetch, because a pre-signed PUT
 * must carry Content-Length and fetch sends a stream body chunked.
 */
async function putWholeFromDrive(
  input: { url: string; fileId: string; bytes: number; contentType: string; hash: string; transferMs: number },
): Promise<{ ok: true; etag: string | null } | { ok: false; status: number; detail: string }> {
  const src = await driveMediaStream(input.fileId, input.transferMs);
  if (!src.ok || !src.body) return { ok: false, status: 0, detail: 'Drive answered HTTP ' + src.status + ' to the download.' };
  const body = Readable.fromWeb(src.body as unknown as import('node:stream/web').ReadableStream);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(input.url, {
      method: 'PUT',
      headers: { 'content-type': input.contentType, 'content-length': String(input.bytes), 'x-amz-checksum-sha256': input.hash },
      timeout: input.transferMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (text.length < 2_000) text += c; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) resolve({ ok: true, etag: bareEtag(res.headers.etag as string | undefined) });
        else resolve({ ok: false, status, detail: said(text) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Moving the video into Metricool ran out of time.')));
    req.on('error', reject);
    pipeline(body, req).catch(reject);
  });
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
      message: mb(sizeBytes) + ' is more than the ' + mb(DIRECT_UPLOAD_MAX_BYTES) + ' this route carries inside one request.',
    };
  }
  const contentType = 'video/mp4';
  // STAGED OR STREAMED. Up to the scratch disk's ceiling the file is written
  // to /tmp once and sliced from there — the proven path. Above it, the disk
  // is never touched: one pass to hash, then each slice by Range request. A
  // file whose size Drive did not report is staged, because the streamed
  // path declares slices from the size before it reads a byte.
  const streamed = sizeBytes != null && sizeBytes > DIRECT_UPLOAD_STAGE_BYTES;

  let dir: string | null = null;
  /** Whether this request holds the video's claim, and must let it go on every way out. */
  let claimed = false;
  try {
    if (left() < 20_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to move the video.' };
    let tmp: string | null = null;
    let bytes: number;
    let declared: DeclaredPart[];
    let wholeHash: string | null = null;
    // An upload of this video that an earlier request did not finish. Its
    // hashes are reused whatever else happens; its signed addresses and ETags
    // only while they are still good.
    // ONE REQUEST AT A TIME on a streamed file. The composer sends a post to
    // its networks in parallel and each send asks for the copy; without the
    // claim, three requests hashed and uploaded the same 2.7 GB file at once
    // and overwrote each other's record. The others answer "in progress".
    if (streamed) {
      claimed = await claimUpload(id, sizeBytes as number, opts.blogId ?? null);
      if (!claimed) {
        return {
          ok: false, reason: 'pending', sizeBytes,
          message: 'This video is being uploaded into Metricool by another request right now. It carries on from where that one gets to; send again in a few minutes.',
        };
      }
    }
    const prior = streamed ? await loadUploadState(id) : null;
    const total = sizeBytes != null ? partRanges(sizeBytes).length : 0;
    // The same file: same size, and never more slices than it has.
    const priorFits = Boolean(prior && sizeBytes != null && prior.sizeBytes === sizeBytes && prior.declared.length <= total);
    const priorHashed = Boolean(prior && priorFits && prior.declared.length === total);
    if (streamed && prior && priorHashed) {
      // 1 (resumed). The hashes were paid for once already.
      bytes = sizeBytes as number;
      declared = prior.declared;
      console.info('metricool:upload resumed', bytes, 'bytes,', Object.keys(prior.etags).length, 'of', declared.length, 'parts already there');
    } else if (streamed) {
      // 1 (streamed). Hashing as the bytes go by, nothing kept — and RESUMED
      // from the last slice an earlier request measured, because this pass
      // is the one thing that once had to fit a single request, and a 2.7 GB
      // reel does not always. It stops at a slice boundary while there is
      // still time to bank what it has.
      const pass = await declarePartsFromDrive(id, sizeBytes as number, Math.min(250_000, left() - 20_000), {
        declared: prior && priorFits ? prior.declared : [],
        stopWhen: () => left() < BATCH_RESERVE_MS,
      });
      await saveHashingProgress(id, { sizeBytes: sizeBytes as number, declared: pass.declared, hashedBytes: pass.bytes, blogId: opts.blogId ?? null });
      if (!pass.complete) {
        console.info('metricool:upload hashing pending', pass.declared.length, 'of', total, 'parts measured');
        return {
          ok: false, reason: 'pending', sizeBytes, progress: { done: 0, total },
          message: 'Measuring the video for Metricool: ' + pass.declared.length + ' of ' + total + ' slices done (' + mb(pass.bytes) + ' of ' + mb(sizeBytes as number) +
            '). It continues on the next pass — the video sweep runs every 15 minutes, or press again — and the upload itself follows.',
        };
      }
      bytes = pass.bytes;
      declared = pass.declared;
      wholeHash = pass.wholeHash;
      console.info('metricool:upload streamed', bytes, 'bytes hashed in', declared.length, 'parts');
    } else {
      // 1 (staged). THE BYTES, out of Drive and onto the scratch disk. First,
      // because the transaction declares each slice's checksum, and a checksum
      // needs the bytes.
      dir = await mkdtemp(join(tmpdir(), 'chi-upload-'));
      tmp = join(dir, id + '.mp4');
      const res = await driveMediaStream(id, Math.min(240_000, left() - 15_000));
      if (!res.ok || !res.body) {
        return { ok: false, reason: 'unreachable', sizeBytes, message: 'Drive answered HTTP ' + res.status + ' to the download.' };
      }
      await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), createWriteStream(tmp));
      bytes = (await stat(tmp)).size;
      if (sizeBytes != null && bytes !== sizeBytes) {
        return { ok: false, reason: 'failed', sizeBytes, message: 'The download stopped at ' + bytes.toLocaleString() + ' of ' + sizeBytes.toLocaleString() + ' bytes.' };
      }
      if (bytes <= 0) return { ok: false, reason: 'failed', sizeBytes, message: 'Drive handed over an empty file.' };
      if (bytes > DIRECT_UPLOAD_STAGE_BYTES) {
        // Only reachable when Drive reported no size: the streamed path could
        // not be chosen, and the disk cannot hold what arrived.
        return { ok: false, reason: 'too_large', sizeBytes: bytes, message: mb(bytes) + ' is more than the ' + mb(DIRECT_UPLOAD_STAGE_BYTES) + ' this function can stage for an upload.' };
      }
      // 2. THE TRANSACTION. The file declared in slices, each with its hash;
      // Metricool names where each slice goes.
      declared = await declareParts(tmp, bytes);
    }
    if (left() < 20_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to open the upload.' };
    // The signed addresses of an earlier request, while they still work: an
    // upload is resumed into the SAME transaction or not at all, because a
    // reopened one is a different S3 upload id and its slices start again.
    const stillGood = prior && priorHashed && prior.tx && (prior.expiresAt == null || prior.expiresAt - Date.now() > 60_000) && prior.tx.uploadType === 'MULTIPART';
    let tx: OpenedTransaction;
    let txStatus = 200;
    let etags: Record<string, string> = {};
    if (stillGood && prior && prior.tx) {
      tx = prior.tx;
      etags = { ...prior.etags };
    } else {
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
      tx = opened.tx;
      txStatus = opened.status;
      // Banked at once for a streamed multipart upload: from here on, whatever
      // this request manages is kept, and the hashes never have to be paid
      // for again.
      if (streamed && tx.uploadType === 'MULTIPART') {
        await saveUploadState({
          videoId: id, blogId: opts.blogId ?? null, sizeBytes: bytes, contentType, declared, tx, etags: {},
          expiresAt: tx.expiresAt ?? Date.now() + DEFAULT_SIGNED_TTL_MS,
        });
      }
    }
    /** Whether what this request leaves behind is picked up by the next one. */
    const resumable = streamed && tx.uploadType === 'MULTIPART';
    const opened = { status: txStatus };
    const unreadable = (what: string): DirectUpload => {
      // The one failure whose fix is a key name. Types only: the reply may
      // carry a credential, and the shape is the diagnosis.
      console.warn('metricool:upload-transaction unreadable', opened.status, tx.shape, what);
      return {
        ok: false, reason: 'unreadable', status: opened.status, shape: tx.shape, sizeBytes,
        message: 'Metricool opened an upload but this app could not find ' + what + ' in its answer (it replied with ' + tx.shape + ').',
      };
    };

    // 3. THE UPLOAD, to the address(es) Metricool named. Staged: openAsBlob
    // hands fetch a body with a known length without reading the file into
    // memory, and a slice of it is still file-backed. Streamed: each slice is
    // fetched from Drive by Range request as its turn comes.
    if (left() < 10_000) return { ok: false, reason: 'failed', sizeBytes, message: 'There was no time left to upload the video.' };
    const whole = tmp ? await openAsBlob(tmp, { type: contentType }) : null;
    const uploaded: UploadedPart[] = [];
    if (tx.uploadType === 'MULTIPART') {
      if (!tx.uploadId || !tx.key) return unreadable('the multipart upload id and key');
      if (!tx.parts.length) return unreadable('a signed address per part');
      if (tx.parts.length !== declared.length) {
        console.warn('metricool:upload-transaction signed', tx.parts.length, 'parts for', declared.length, 'declared');
      }
      // The slices already in S3 from an earlier request are not sent again.
      for (const [n, etag] of Object.entries(etags)) uploaded.push({ partNumber: Number(n), etag });
      const todo = tx.parts.filter((p) => !etags[String(p.partNumber)]);
      const concurrency = whole ? PART_CONCURRENCY : STREAMED_PART_CONCURRENCY;
      for (let i = 0; i < todo.length; i += concurrency) {
        // A resumable upload stops BEFORE a batch it cannot finish, with its
        // ETags banked, rather than dying mid-slice with nothing to show. A
        // staged one is small enough to run on; its timeouts still hold.
        if (resumable && left() < BATCH_RESERVE_MS) {
          await saveUploadEtags(id, etags);
          const done = uploaded.length;
          const total = tx.parts.length;
          console.info('metricool:upload pending', done, 'of', total, 'parts; continues next pass');
          return {
            ok: false,
            reason: 'pending',
            sizeBytes,
            progress: { done, total },
            message: 'Uploading into Metricool: ' + done + ' of ' + total + ' slices are there (' +
              mb(Math.min(bytes, done * declared[0].size)) + ' of ' + mb(bytes) + '). It continues on the next pass — the video sweep runs every ' +
              '15 minutes, or press again — and the drafts get their video when it lands.',
          };
        }
        const batch = todo.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (part) => {
          // The range and the checksum are the declared part's, by number — the
          // web app pairs them by position, and a reply that renumbers them would
          // fail S3's checksum rather than send the wrong bytes quietly.
          const mine = declared[part.partNumber - 1];
          if (!mine) return { ok: false as const, status: 0, detail: 'part ' + part.partNumber + ' was signed but never declared', partNumber: part.partNumber };
          const start = part.startByte ?? mine.startByte;
          const end = part.endByte ?? mine.endByte;
          const blob = whole
            ? whole.slice(start, end, contentType)
            : await partFromDrive(id, start, end, contentType, Math.max(10_000, left() - 10_000));
          const r = await putPart({ url: part.presignedUrl, blob, contentType, hash: mine.hash, left });
          return { ...r, partNumber: part.partNumber };
        }));
        for (const r of results) {
          if (!r.ok) {
            console.warn('metricool:upload part non-ok', r.partNumber, r.status, r.detail);
            const message = 'Metricool opened a multipart upload (' + tx.parts.length + ' parts) but part ' + r.partNumber + ' was refused by the storage it named' +
              (r.status ? ' (' + r.status + ')' : '') + (r.detail ? ': ' + r.detail : '.');
            // The addresses are no good; the hashes still are. Next pass reopens.
            if (resumable) await resetUploadState(id, message);
            return { ok: false, reason: r.status >= 500 ? 'unreachable' : 'refused', status: r.status || null, sizeBytes, message };
          }
          if (!r.etag) {
            const message = 'Part ' + r.partNumber + ' went up but the storage returned no ETag, and the completion is made of ETags.';
            if (resumable) await resetUploadState(id, message);
            return { ok: false, reason: 'unreadable', sizeBytes, message };
          }
          uploaded.push({ partNumber: r.partNumber, etag: r.etag });
          etags[String(r.partNumber)] = r.etag;
        }
        if (resumable) await saveUploadEtags(id, etags);
      }
    } else {
      // SIMPLE — or a type this code does not know, sent the simple way and
      // reported by name if it is wrong. The checksum is the whole file's: for
      // one declared part that is the part's hash, and for more it is what an
      // S3 PUT of the whole object actually checks.
      if (!tx.presignedUrl) return unreadable('a signed upload address');
      if (tx.uploadType !== 'SIMPLE') console.warn('metricool:upload-transaction unknown type, sent as SIMPLE', tx.uploadType);
      // A streamed file resumed from its stored hashes has no whole-file hash;
      // a SIMPLE reply for one is not expected, but a reply is read, not
      // assumed, so the pass is made once more.
      if (!tmp && !wholeHash && declared.length > 1) wholeHash = (await declarePartsFromDrive(id, bytes, Math.min(200_000, Math.max(10_000, left() - 20_000)))).wholeHash;
      const hash = declared.length === 1 ? declared[0].hash : (wholeHash ?? await sha256Base64(tmp as string, 0, bytes));
      const r = whole
        ? await putPart({ url: tx.presignedUrl, blob: whole, contentType, hash, left })
        : await putWholeFromDrive({ url: tx.presignedUrl, fileId: id, bytes, contentType, hash, transferMs: Math.max(10_000, left() - 10_000) });
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
      const message = 'The bytes went up (' + mb(bytes) + ', ' + (tx.uploadType || 'simple').toLowerCase() + ') but Metricool answered ' + done.status +
        ' to completing the upload, so it has no file yet' + (detail ? '. It said: ' + detail : '.');
      // A 5xx is theirs and this transaction may still complete next pass; a
      // refusal means the transaction is spent, and the next pass reopens it.
      if (resumable && done.status < 500) await resetUploadState(id, message);
      return { ok: false, reason: done.status >= 500 ? 'unreachable' : 'refused', status: done.status, shape: tx.shape, sizeBytes, message };
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
    const copyId = metricoolCopyId(finished.key || tx.key || new URL(fileUrl).pathname);
    if (resumable) await finishUploadState(id, { fileUrl, copyId });
    return { ok: true, url: fileUrl, copyId, bytes, sizeBytes };
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
    if (claimed) await releaseUpload(id);
  }
}

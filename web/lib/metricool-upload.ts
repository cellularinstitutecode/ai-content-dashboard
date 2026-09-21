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
// API for an upload transaction — PUT /v2/media/s3/upload-transactions with a
// filename and content type — is handed a pre-signed S3 address, and PUTs the
// bytes there. That is what this does: the file is streamed out of Drive with
// the service account that already reads it, staged on the scratch disk so its
// length is known, and pushed to the address Metricool named. The result is a
// file on storage Metricool trusts, which its own clients send in `media`
// without a normalise step at all.
//
// What is NOT known is the transaction's exact reply, which the public docs do
// not describe. lib/metricool-upload-parse.ts reads it for the two addresses
// that matter and reports the shape in types when it cannot; a reply nobody
// anticipated is then one key name away from working, on the screen, instead
// of a console line nobody reads.
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
import { directUploadEnabled, isMetricoolHostedUrl, metricoolCopyId, readUploadTransaction } from '@/lib/metricool-upload-parse';
import { reportError } from '@/lib/report';

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

/** The transaction request. One small JSON call; it should not take long. */
const TRANSACTION_MS = 30_000;
/** What the whole route may spend, inside a 300-second function. */
const DEFAULT_BUDGET_MS = 270_000;

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
  let txStatus: number | null = null;
  let txText = '';
  try {
    const res = await metricoolFetch('/v2/media/s3/upload-transactions', {
      method: 'PUT',
      body: JSON.stringify({ filename, contentType }),
      timeoutMs: Math.min(TRANSACTION_MS, Math.max(5_000, left())),
      blogId: opts.blogId,
    });
    txStatus = res.status;
    txText = await res.text();
    if (!res.ok) {
      console.warn('metricool:upload-transaction non-ok', res.status, txText.slice(0, 200));
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'refused' : res.status >= 500 ? 'unreachable' : 'refused',
        status: res.status,
        sizeBytes,
        message: 'Metricool answered ' + res.status + ' when asked to open an upload' + (res.status === 404 ? ' — no such endpoint on this account' : '') + '.',
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportError('metricool-upload:transaction', e, { fileId: id });
    return { ok: false, reason: 'unreachable', sizeBytes, message: 'Metricool could not be reached to open an upload: ' + message };
  }
  const tx = readUploadTransaction(txText);
  if (!tx.uploadUrl || !tx.fileUrl) {
    // The one failure whose fix is a key name. Types only: the reply may
    // carry a credential, and the shape is the diagnosis.
    console.warn('metricool:upload-transaction unreadable', txStatus, tx.shape, txText.slice(0, 300));
    return {
      ok: false,
      reason: 'unreadable',
      status: txStatus,
      shape: tx.shape,
      sizeBytes,
      message: 'Metricool opened an upload but this app could not find the ' + (tx.uploadUrl ? 'file address' : 'upload address') +
        ' in its answer (it replied with ' + tx.shape + ').',
    };
  }
  if (!isMetricoolHostedUrl(tx.fileUrl)) {
    // Recorded so the trusted-host list can be widened by one line, not sent:
    // a file address on a host Metricool does not trust is a normalise that
    // will echo, which is the failure this route exists to end.
    console.warn('metricool:upload-transaction unfamiliar host', tx.fileUrl.slice(0, 120));
  }
  console.info('metricool:upload-transaction opened', tx.method, tx.shape);

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
      const detail = (await up.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      console.warn('metricool:upload non-ok', up.status, detail);
      return {
        ok: false,
        reason: 'refused',
        status: up.status,
        sizeBytes,
        message: 'The storage Metricool named refused the upload (' + up.status + ')' + (detail ? ': ' + detail : '.'),
      };
    }
    await up.text().catch(() => '');
    console.info('metricool:upload done', bytes, 'bytes');
    return { ok: true, url: tx.fileUrl, copyId: metricoolCopyId(tx.id || new URL(tx.fileUrl).pathname), bytes, sizeBytes };
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

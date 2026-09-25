// web/lib/metricool-upload-parse.ts
// Reading Metricool's answer to "I want to upload a file" — and knowing a
// Metricool-hosted URL when one is seen.
//
// WHY THIS EXISTS. Every video this app has sent since 15 September was handed
// to Metricool as a LINK, and Metricool was asked to pull the file across. Row
// 191 settled what that gets a video: the one normalise endpoint that exists
// (/actions/normalize/image/url) hands a Drive link straight back, and the
// link this app can mint itself is served by a Vercel function that cannot
// deliver a whole reel. So the file never moved, and the post was refused —
// correctly — at the door.
//
// Metricool's own uploader does not work that way. Its media library asks for
// an UPLOAD TRANSACTION (PUT /v2/media/s3/upload-transactions with a filename
// and a content type), is handed a pre-signed S3 address, and PUTs the bytes
// there itself. No link has to be fetchable by anybody; the file simply
// arrives on the storage Metricool already trusts — static.metricool.com and
// the metricool-* S3 buckets, which Metricool's own clients never send through
// normalise at all (their word for those hosts is "already normalized").
//
// The transaction is not in the public documentation, so on 21 September it
// was CAPTURED from Metricool's own web app while it uploaded a video — the
// request, the reply, the S3 PUT and the completion, plus the uploader's
// source (MediaService.uploadFileToS3 in app-*.js). The exact protocol is in
// the section "the transaction, as Metricool's uploader speaks it" below, and
// lib/metricool-upload.ts sends it word for word. The older, shape-guessing
// reader (readUploadTransaction) stays as the fallback that describes an
// unexpected reply in types.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { describeShape } from './metricool-normalize-parse.ts';

// --- hosts Metricool already trusts ------------------------------------------

/**
 * Hosts whose files Metricool fetches without a normalise step.
 *
 * The three named ones are the list Metricool's own MCP client carries as
 * "hosts whose assets Metricool can already download directly — never
 * renormalized". The patterns beside them cover the same storage under its
 * other spellings (a regional or path-style S3 address, another metricool.com
 * subdomain). app.metricool.com is excluded on purpose: that is the API and
 * the web app, and an API address handed back is an error page, not a video.
 */
export const METRICOOL_HOSTED_HOSTS: readonly string[] = [
  'static.metricool.com',
  'metricool-download.s3.eu-west-1.amazonaws.com',
  'metricool-data.s3.eu-west-1.amazonaws.com',
];

/** Is this a URL on storage Metricool already trusts, so it needs no normalise? */
export function isMetricoolHostedUrl(url: string | null | undefined): boolean {
  let u: URL;
  try { u = new URL(String(url || '').trim()); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (METRICOOL_HOSTED_HOSTS.includes(host)) return true;
  // metricool-<anything>.s3.<region>.amazonaws.com, or the legacy s3-<region> form.
  if (/^metricool[a-z0-9-]*\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host)) return true;
  // Path-style: s3.<region>.amazonaws.com/metricool-<bucket>/…
  if (/^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) && /^\/metricool[a-z0-9-]*\//i.test(u.pathname)) return true;
  // Any other metricool.com subdomain (a CDN in front of the same storage).
  if (host.endsWith('.metricool.com') && host !== 'app.metricool.com') return true;
  return false;
}

// --- the switch ----------------------------------------------------------------

/**
 * May this app upload a video straight into Metricool?
 *
 * On unless somebody turns it off: the path it replaces is a refusal, so there
 * is nothing it can make worse — a failed upload falls through to exactly the
 * routes that ran before it existed. Off exists for the day Metricool changes
 * the endpoint and the extra call becomes noise in every send.
 */
export function directUploadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = String(env.METRICOOL_DIRECT_UPLOAD ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

// --- the copy-id marker --------------------------------------------------------
//
// public_copy_id and posts.media_drive_file_id have held three kinds of thing —
// a Drive copy's id, a bucket object key, and 'stream:<id>' — and this is the
// fourth. Like the stream marker it carries a colon, which no Drive id and no
// bucket key does, so every delete dispatcher's cheap total test still holds:
// nothing with a colon in it is a file this app may destroy in Drive. There
// is nothing to delete for one of these either: the bytes are Metricool's.

const METRICOOL_PREFIX = 'metricool:';

export function metricoolCopyId(key: string): string {
  return METRICOOL_PREFIX + String(key || '').trim();
}

export function isMetricoolCopyId(id: string | null | undefined): boolean {
  return String(id || '').startsWith(METRICOOL_PREFIX);
}

/**
 * The marker for a Metricool-hosted URL, or null.
 *
 * Identification only, for the row that records what a post carries. The
 * path is the key the upload was recorded under when the transaction named no
 * id of its own (lib/metricool-upload.ts), so a URL and its record agree.
 */
export function metricoolCopyIdFromUrl(url: string | null | undefined): string | null {
  if (!isMetricoolHostedUrl(url)) return null;
  try { return metricoolCopyId(new URL(String(url)).pathname); } catch { return null; }
}

// --- reading the transaction ---------------------------------------------------

/** One pre-signed part address of a multipart upload. */
export type UploadPart = { partNumber: number | null; url: string };

export type UploadTransaction = {
  /** Where the bytes go: a pre-signed address, or null when none was found. */
  uploadUrl: string | null;
  /**
   * Every pre-signed part address, in the order the reply gave them.
   *
   * Metricool's transaction is a multipart one — it asks for `parts` before it
   * will open — so the reply is expected to carry one signed address per part.
   * `uploadUrl` is the first of them.
   */
  parts: UploadPart[];
  /** S3's multipart upload id, when the reply named one. A reply with one needs completing. */
  uploadId: string | null;
  /** The object key, when the reply named one. */
  key: string | null;
  /** PUT to a pre-signed URL, or POST a form (S3's presigned-post shape). */
  method: 'PUT' | 'POST';
  /** Headers the reply asked to be sent with the bytes. Verbatim. */
  headers: Record<string, string>;
  /** Form fields for a presigned POST, when the reply carried them. */
  fields: Record<string, string> | null;
  /** The address the file will have once it is there, or null. */
  fileUrl: string | null;
  /** The transaction's own id, when it named one. */
  id: string | null;
  /** The reply's structure in types, for the diagnosis when a field is null. */
  shape: string;
};

const MAX_DEPTH = 6;
const MAX_NODES = 500;

/** A URL carrying an S3-style signature: the address you PUT to, never the file's. */
function isPresignedUrl(url: string): boolean {
  return /[?&](X-Amz-Signature|X-Amz-Credential|X-Amz-Algorithm|AWSAccessKeyId|Signature|sig|sv|se)=/i.test(url);
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
}

const UPLOAD_KEY = /upload|presign|signed|put/i;
const FILE_KEY = /download|public|file|media|final|result|resource|location|href|src|url|uri/i;
const HEADERS_KEY = /^(headers|requiredHeaders|uploadHeaders|signedHeaders)$/i;
const FIELDS_KEY = /^(fields|formFields|formData)$/i;
const METHOD_KEY = /^(method|httpMethod|verb)$/i;
const ID_KEY = /^(id|transactionId|transaction_id)$/i;
const UPLOAD_ID_KEY = /^(uploadId|upload_id|multipartUploadId)$/i;
const KEY_KEY = /^(key|objectKey|object_key|path|filename|fileName)$/i;
const PART_NUMBER_KEY = /^(partNumber|part_number|number|part|index)$/i;
const BUCKET_KEY = /^(bucket|bucketName|bucket_name)$/i;
const REGION_KEY = /^(region|awsRegion|aws_region)$/i;

/** The file's address without the signature: what remains once the PUT is done. */
function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url.split('?')[0];
  }
}

function stringMap(node: unknown): Record<string, string> | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The upload address and the file address in Metricool's reply.
 *
 * Rules, in order of trust: a signed URL under a key that says "upload" beats
 * a signed URL anywhere, which beats an unsigned URL under such a key. The
 * file's address is an unsigned URL under a key that says "file"; when there
 * is none, it is the upload address with its signature removed — which is what
 * an S3 object is called once the PUT completes — and when there is not even
 * that but a bucket and a key were named, it is built from those.
 */
export function readUploadTransaction(raw: string): UploadTransaction {
  const empty: UploadTransaction = {
    uploadUrl: null, parts: [], uploadId: null, key: null, method: 'PUT', headers: {}, fields: null, fileUrl: null, id: null, shape: 'empty',
  };
  const text = String(raw || '').trim();
  if (!text) return empty;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const bare = text.replace(/^"|"$/g, '').trim();
    if (!isHttpUrl(bare)) return { ...empty, shape: 'text' };
    // A bare pre-signed URL and nothing else: the address to PUT to, and the
    // file is that address without its signature.
    return { ...empty, uploadUrl: bare, fileUrl: isPresignedUrl(bare) ? stripQuery(bare) : null, shape: 'string' };
  }
  if (isHttpUrl(data)) {
    const bare = String(data).trim();
    return { ...empty, uploadUrl: bare, fileUrl: isPresignedUrl(bare) ? stripQuery(bare) : null, shape: 'string' };
  }

  let signedUnderUploadKey: string | null = null;
  let signedAnywhere: string | null = null;
  let plainUnderUploadKey: string | null = null;
  let plainUnderFileKey: string | null = null;
  let plainAnywhere: string | null = null;
  let headers: Record<string, string> = {};
  let fields: Record<string, string> | null = null;
  let method: 'PUT' | 'POST' | null = null;
  let id: string | null = null;
  let uploadId: string | null = null;
  let key: string | null = null;
  let bucket: string | null = null;
  let region: string | null = null;
  const parts: UploadPart[] = [];

  let seen = 0;
  const walk = (node: unknown, k: string, depth: number): void => {
    if (node == null || depth > MAX_DEPTH || seen++ > MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, k, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      // A part: an object holding a signed address, with its number beside it.
      const own = Object.entries(node as Record<string, unknown>);
      const signed = own.find(([, v]) => isHttpUrl(v) && isPresignedUrl(String(v)));
      if (signed) {
        const num = own.find(([ok, ov]) => PART_NUMBER_KEY.test(ok) && Number.isFinite(Number(ov)));
        parts.push({ partNumber: num ? Number(num[1]) : null, url: String(signed[1]).trim() });
      }
      if (HEADERS_KEY.test(k)) {
        const m = stringMap(node);
        if (m && !Object.keys(headers).length) headers = m;
        return;
      }
      if (FIELDS_KEY.test(k)) {
        const m = stringMap(node);
        if (m && !fields) fields = m;
        return;
      }
      for (const [ck, cv] of Object.entries(node as Record<string, unknown>)) walk(cv, ck, depth + 1);
      return;
    }
    if (isHttpUrl(node)) {
      const url = String(node).trim();
      if (isPresignedUrl(url)) {
        if (!signedUnderUploadKey && UPLOAD_KEY.test(k)) signedUnderUploadKey = url;
        if (!signedAnywhere) signedAnywhere = url;
      } else {
        if (!plainUnderUploadKey && UPLOAD_KEY.test(k)) plainUnderUploadKey = url;
        else if (!plainUnderFileKey && FILE_KEY.test(k)) plainUnderFileKey = url;
        if (!plainAnywhere) plainAnywhere = url;
      }
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      const v = String(node).trim();
      if (!v) return;
      if (METHOD_KEY.test(k) && /^(put|post)$/i.test(v)) method = v.toUpperCase() as 'PUT' | 'POST';
      else if (ID_KEY.test(k) && !id && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v)) id = v;
      else if (UPLOAD_ID_KEY.test(k) && !uploadId && /^[^\s]{1,400}$/.test(v)) uploadId = v;
      else if (KEY_KEY.test(k) && !key && /^[^\s]{1,400}$/.test(v)) key = v;
      else if (BUCKET_KEY.test(k) && !bucket && /^[a-z0-9.-]{3,63}$/.test(v)) bucket = v;
      else if (REGION_KEY.test(k) && !region && /^[a-z]{2}-[a-z]+-\d$/.test(v)) region = v;
    }
  };
  walk(data, '', 0);

  // Parts in their numbered order; the first is where a single-part upload goes.
  parts.sort((a, b) => (a.partNumber ?? Number.MAX_SAFE_INTEGER) - (b.partNumber ?? Number.MAX_SAFE_INTEGER));
  // A presigned POST (S3's form shape) signs the FIELDS, not the address, so
  // its address is a plain bucket URL under whatever key the reply chose.
  const uploadUrl: string | null = (parts[0]?.url) || signedUnderUploadKey || signedAnywhere || plainUnderUploadKey || (fields ? plainAnywhere : null) || null;
  const uploaded = uploadUrl ? stripQuery(uploadUrl) : null;
  const formKey = fields ? String((fields as Record<string, string>).key || '').trim() : '';
  let fileUrl: string | null = plainUnderFileKey && plainUnderFileKey !== uploaded ? plainUnderFileKey : null;
  if (!fileUrl && plainAnywhere && plainAnywhere !== uploaded && plainAnywhere !== plainUnderUploadKey) fileUrl = plainAnywhere;
  if (!fileUrl && fields && formKey && uploadUrl) {
    // The form's key names the object under the bucket the form posts to.
    try { fileUrl = new URL(formKey.replace(/^\/+/, ''), uploaded + '/').toString().replace(/([^:])\/{2,}/g, '$1/'); } catch { /* fall through */ }
  }
  // Read back through their declared types: the assignments above happen
  // inside the walker's closure, which control-flow narrowing does not see.
  const keyName = key as string | null;
  const bucketName = bucket as string | null;
  const regionName = region as string | null;
  const named = bucketName && keyName
    ? 'https://' + bucketName + '.s3.' + (regionName || 'eu-west-1') + '.amazonaws.com/' + keyName.replace(/^\/+/, '')
    : null;
  // The signed address without its signature is what an S3 object is called
  // once the PUT completes — unless the reply named a bucket and key of its
  // own and the signed address is somewhere else entirely, in which case the
  // named object is the file and the signed address was only the door.
  if (!fileUrl && uploadUrl && isPresignedUrl(uploadUrl) && uploaded && (!named || isMetricoolHostedUrl(uploaded))) fileUrl = uploaded;
  if (!fileUrl && named) fileUrl = named;

  return {
    uploadUrl,
    parts,
    uploadId: uploadId as string | null,
    key: keyName,
    method: method || (fields ? 'POST' : 'PUT'),
    headers,
    fields,
    fileUrl,
    id: (id as string | null) || (uploadId as string | null) || keyName,
    shape: describeShape(data),
  };
}

// --- reading a refusal ---------------------------------------------------------

/**
 * The values an enum field accepts, when a refusal lists them.
 *
 * A Java backend answering a wrong enum value says so in the Jackson way:
 * "not one of the values accepted for Enum class: [IMAGE, VIDEO]". The list
 * is the fix, so it is read rather than re-guessed.
 */
export function acceptedValues(refusal: string): string[] {
  const text = String(refusal || '');
  const m = /accepted for Enum class:\s*\[([^\]]+)\]/i.exec(text) || /(?:allowed|accepted|expected|valid)\s+values?[^[]{0,40}\[([^\]]+)\]/i.exec(text);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => /^[A-Za-z0-9_-]{1,40}$/.test(s));
}

/**
 * The field names a validation refusal complains about, lower-cased.
 *
 * Metricool's shape: {"status":"BAD_REQUEST","title":"ValidationError",
 * "detail":{"resourceType":"Resource type is required","parts":"…"}}. Any
 * key under `detail` (or `errors`, `fieldErrors`) is a field it wants.
 */
export function refusedFields(refusal: string): string[] {
  let data: unknown;
  try { data = JSON.parse(String(refusal || '')); } catch { return []; }
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const detail = d.detail ?? d.errors ?? d.fieldErrors ?? d.violations;
  if (!detail || typeof detail !== 'object') return [];
  if (Array.isArray(detail)) {
    return detail.map((e) => String((e as { field?: unknown })?.field || '').toLowerCase()).filter(Boolean);
  }
  return Object.keys(detail as Record<string, unknown>).map((k) => k.toLowerCase());
}

// --- the transaction, as Metricool's uploader speaks it ------------------------
//
// Captured 21 September 2026 from app.metricool.com saving a post with a video
// (a 5 KB test clip, deleted afterwards), and read against the uploader's own
// source. Four steps, every one of them below:
//
//   1. PUT  /v2/media/s3/upload-transactions
//        {"resourceType":"planner","contentType":"video/mp4","size":N,
//         "parts":[{"size":n,"startByte":0,"endByte":n,"hash":"<base64 sha256>"}, …]}
//      The file is declared in 25 MB slices (CHUNK_MIN_PART_SIZE_BYTES in the
//      web app), each with the base64 SHA-256 of its bytes. The bare-number
//      part this app once sent is what Metricool's Jackson could not build an
//      S3UploadPart from.
//      → {"data":{"uploadType":"SIMPLE","presignedUrl":"…","key":"planner/<user>/<yyyymm>/<id>.mp4",
//                 "bucket":"metricool-temp","fileUrl":"https://metricool-temp.s3.eu-west-1.amazonaws.com/<key>",
//                 "uploadId":null,"parts":null,"totalSize":N,"expiresAt":…}}
//      or, for a bigger file, "uploadType":"MULTIPART" with "uploadId" and
//      "parts":[{"partNumber":1,"presignedUrl":"…", …}] — one signed address per
//      declared slice.
//   2. PUT <presignedUrl> with the bytes, headers Content-Type and
//      x-amz-checksum-sha256: <that part's hash>. A multipart part's reply
//      carries the ETag the completion needs.
//   3. PATCH /v2/media/s3/upload-transactions
//        {"simple":{"fileUrl":"<fileUrl>"}}
//      or {"multipart":{"uploadId":"…","key":"…","parts":[{"partNumber":1,"etag":"…"}, …]}}
//      → {"data":{"key":"…","bucket":"…","fileUrl":"…","etag":null,
//                 "convertedFileUrl":"https://static.metricool.com/video/<user>/<yyyymm>/<id>.mp4"}}
//   4. The post carries convertedFileUrl — static.metricool.com, the host
//      Metricool's own clients send without a normalise.

/** Metricool's uploader declares a file in slices of this size. */
export const UPLOAD_PART_BYTES = 25 * 1024 * 1024;
/** The resource type Metricool's planner uploads under. */
export const UPLOAD_RESOURCE_TYPE = 'planner';

/** One declared slice of the file: [startByte, endByte), with its checksum. */
export type DeclaredPart = { size: number; startByte: number; endByte: number; hash: string };

/** The slices a file of this size is declared in, in order, before hashing. */
export function partRanges(size: number, partBytes = UPLOAD_PART_BYTES): { startByte: number; endByte: number; size: number }[] {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  const step = Math.max(1, Math.floor(partBytes));
  const out: { startByte: number; endByte: number; size: number }[] = [];
  for (let start = 0; start < total; start += step) {
    const end = Math.min(total, start + step);
    out.push({ startByte: start, endByte: end, size: end - start });
  }
  return out;
}

/** The body that opens a transaction: exactly the fields the web app sends. */
export function transactionBody(input: { contentType: string; size: number; parts: DeclaredPart[]; resourceType?: string }): {
  resourceType: string; contentType: string; size: number; parts: DeclaredPart[];
} {
  return {
    resourceType: input.resourceType || UPLOAD_RESOURCE_TYPE,
    contentType: input.contentType,
    size: input.size,
    parts: input.parts.map((p) => ({ size: p.size, startByte: p.startByte, endByte: p.endByte, hash: p.hash })),
  };
}

/** One signed part address of a MULTIPART reply. */
export type SignedPart = { partNumber: number; presignedUrl: string; startByte: number | null; endByte: number | null };

export type OpenedTransaction = {
  uploadType: 'SIMPLE' | 'MULTIPART' | null;
  /** SIMPLE: where the whole file goes. */
  presignedUrl: string | null;
  key: string | null;
  bucket: string | null;
  /** MULTIPART: S3's upload id, which the completion must carry. */
  uploadId: string | null;
  /** MULTIPART: one signed address per declared part, in part order. */
  parts: SignedPart[];
  /** The object's address once the bytes are there. */
  fileUrl: string | null;
  /**
   * When the signed addresses stop working, as epoch ms, or null.
   *
   * From the reply's own `expiresAt` when it carries one, else from the first
   * signed address's X-Amz-Date + X-Amz-Expires. An upload resumed after this
   * must reopen the transaction (its hashes are kept; only the addresses are
   * asked for again).
   */
  expiresAt: number | null;
  /** The reply's structure in types, for when a field above is null. */
  shape: string;
};

/**
 * When a pre-signed S3 address expires, as epoch ms, from its own query.
 *
 * X-Amz-Date is `YYYYMMDDTHHMMSSZ` and X-Amz-Expires is seconds from it.
 * Null when either is missing or unreadable: an unknown expiry is not a
 * guess, it is a default the caller chooses.
 */
export function signedUrlExpiry(url: string | null | undefined): number | null {
  let u: URL;
  try { u = new URL(String(url || '')); } catch { return null; }
  const date = u.searchParams.get('X-Amz-Date') || '';
  const expires = Number(u.searchParams.get('X-Amz-Expires'));
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!m || !Number.isFinite(expires) || expires <= 0) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(at) ? at + expires * 1000 : null;
}

/** An `expiresAt` value as the API might write it: epoch seconds, epoch ms, or ISO. */
function readExpiresAt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+$/.test(v.trim())) return readExpiresAt(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** The reply's payload: under `data`, as the API answers, or bare. */
function payloadOf(raw: string): { node: Record<string, unknown> | null; data: unknown } {
  let data: unknown;
  try { data = JSON.parse(String(raw || '').trim() || 'null'); } catch { return { node: null, data: null }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { node: null, data };
  const d = data as Record<string, unknown>;
  const inner = d.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { node: inner as Record<string, unknown>, data };
  return { node: d, data };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

/** Read the reply to step 1. Nothing is invented: a missing field is null. */
export function readOpenedTransaction(raw: string): OpenedTransaction {
  const { node, data } = payloadOf(raw);
  const shape = describeShape(data);
  if (!node) return { uploadType: null, presignedUrl: null, key: null, bucket: null, uploadId: null, parts: [], fileUrl: null, expiresAt: null, shape };
  const type = String(node.uploadType || '').trim().toUpperCase();
  const parts: SignedPart[] = [];
  if (Array.isArray(node.parts)) {
    node.parts.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      const part = p as Record<string, unknown>;
      const url = str(part.presignedUrl) || str(part.url) || str(part.uploadUrl);
      if (!url || !isHttpUrl(url)) return;
      parts.push({
        partNumber: num(part.partNumber) ?? num(part.number) ?? i + 1,
        presignedUrl: url,
        startByte: num(part.startByte),
        endByte: num(part.endByte),
      });
    });
    parts.sort((a, b) => a.partNumber - b.partNumber);
  }
  const presignedUrl = str(node.presignedUrl);
  const signed = presignedUrl && isHttpUrl(presignedUrl) ? presignedUrl : null;
  return {
    uploadType: type === 'SIMPLE' || type === 'MULTIPART' ? type : null,
    presignedUrl: signed,
    key: str(node.key),
    bucket: str(node.bucket),
    uploadId: str(node.uploadId),
    parts,
    fileUrl: (() => { const f = str(node.fileUrl); return f && isHttpUrl(f) ? f : null; })(),
    expiresAt: earliestExpiry([readExpiresAt(node.expiresAt), signedUrlExpiry(parts[0]?.presignedUrl || signed)]),
    shape,
  };
}

/**
 * The soonest of the expiries on offer, ignoring any that cannot be a time.
 *
 * `expiresAt` in the reply is not documented: a duration in seconds (3600)
 * read as an epoch is 1970, and an upload judged by that would be reopened
 * on every pass — its slices thrown away each time. Anything before 2020 is
 * not a time this code can be running at, and is not used.
 */
export function earliestExpiry(candidates: readonly (number | null | undefined)[]): number | null {
  const floor = Date.UTC(2020, 0, 1);
  const good = candidates.filter((c): c is number => typeof c === 'number' && Number.isFinite(c) && c >= floor);
  return good.length ? Math.min(...good) : null;
}

/** What a finished part is reported as: its number and the ETag S3 answered with. */
export type UploadedPart = { partNumber: number; etag: string };

/** The body that completes the transaction (step 3), one shape per upload type. */
export function completionBody(
  tx: Pick<OpenedTransaction, 'uploadType' | 'fileUrl' | 'presignedUrl' | 'uploadId' | 'key'>,
  uploaded: UploadedPart[],
): { simple: { fileUrl: string } } | { multipart: { uploadId: string; key: string; parts: UploadedPart[] } } {
  if (tx.uploadType === 'MULTIPART') {
    return {
      multipart: {
        uploadId: String(tx.uploadId || ''),
        key: String(tx.key || ''),
        parts: [...uploaded].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      },
    };
  }
  // The web app sends fileUrl, and falls back to the signed address itself.
  return { simple: { fileUrl: String(tx.fileUrl || tx.presignedUrl || '') } };
}

export type CompletedTransaction = {
  /** Where the post should point: Metricool's converted copy on static.metricool.com. */
  convertedFileUrl: string | null;
  /** The raw object, on the temp bucket. */
  fileUrl: string | null;
  key: string | null;
  etag: string | null;
  shape: string;
};

/** Read the reply to step 3. */
export function readCompletedTransaction(raw: string): CompletedTransaction {
  const { node, data } = payloadOf(raw);
  const shape = describeShape(data);
  if (!node) return { convertedFileUrl: null, fileUrl: null, key: null, etag: null, shape };
  const url = (v: unknown) => { const s = str(v); return s && isHttpUrl(s) ? s : null; };
  return {
    convertedFileUrl: url(node.convertedFileUrl) || url(node.converted_file_url),
    fileUrl: url(node.fileUrl),
    key: str(node.key),
    etag: str(node.etag),
    shape,
  };
}

/** S3 quotes its ETags; the completion wants them bare, as the web app strips them. */
export function bareEtag(header: string | null | undefined): string | null {
  const v = String(header || '').trim().replace(/^W\//, '').replace(/"/g, '');
  return v || null;
}

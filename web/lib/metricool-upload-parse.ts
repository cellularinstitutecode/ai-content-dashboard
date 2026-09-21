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
// The transaction's exact reply is not in the public documentation, so this
// reads it the way lib/metricool-normalize-parse.ts reads the normalise answer:
// find the pre-signed address and the resulting file address in any reasonable
// shape, prefer the keys that say what they are, never invent one, and describe
// in types what could not be read so the next round is a five-minute fix.
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

export type UploadTransaction = {
  /** Where the bytes go: a pre-signed address, or null when none was found. */
  uploadUrl: string | null;
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
const ID_KEY = /^(id|transactionId|transaction_id|uploadId|upload_id)$/i;
const KEY_KEY = /^(key|objectKey|object_key|path|filename|fileName)$/i;
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
  const empty: UploadTransaction = { uploadUrl: null, method: 'PUT', headers: {}, fields: null, fileUrl: null, id: null, shape: 'empty' };
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
  let key: string | null = null;
  let bucket: string | null = null;
  let region: string | null = null;

  let seen = 0;
  const walk = (node: unknown, k: string, depth: number): void => {
    if (node == null || depth > MAX_DEPTH || seen++ > MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, k, depth + 1);
      return;
    }
    if (typeof node === 'object') {
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
      else if (KEY_KEY.test(k) && !key && /^[^\s]{1,400}$/.test(v)) key = v;
      else if (BUCKET_KEY.test(k) && !bucket && /^[a-z0-9.-]{3,63}$/.test(v)) bucket = v;
      else if (REGION_KEY.test(k) && !region && /^[a-z]{2}-[a-z]+-\d$/.test(v)) region = v;
    }
  };
  walk(data, '', 0);

  // A presigned POST (S3's form shape) signs the FIELDS, not the address, so
  // its address is a plain bucket URL under whatever key the reply chose.
  const uploadUrl: string | null = signedUnderUploadKey || signedAnywhere || plainUnderUploadKey || (fields ? plainAnywhere : null) || null;
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
    method: method || (fields ? 'POST' : 'PUT'),
    headers,
    fields,
    fileUrl,
    id: (id as string | null) || keyName,
    shape: describeShape(data),
  };
}

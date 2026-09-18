// web/lib/data-url.ts
// A file dropped on the panel, turned into bytes — carefully.
//
// "Put an OpenAI drop box, like if we were talking to GPT, dropping pictures."
//
// The pictures the clinic wants are its own: a real room, a real machine, real
// hands. Those arrive as a file, and a file arriving from a browser is the one
// input on this whole path that a stranger could shape, so it is read rather
// than trusted: the declared type must be an image this app is willing to
// serve, the payload must decode, and the size must be one Supabase will take.
//
// Pure: no imports, so the test runner reads this file directly. Buffer is
// Node's, available in both the route and the test runner.

/** What a network will fetch and show. SVG is deliberately absent: it is a document. */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Eight megabytes of decoded image.
 *
 * Above this the request body itself is refused by the platform before any of
 * this runs, so a larger limit here would only move the failure somewhere with
 * no message. The picker downscales before it uploads; this is the backstop.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type DecodedImage =
  | { ok: true; bytes: Buffer; contentType: string; ext: string }
  | { ok: false; message: string };

/** How big it is, in the words the message uses. */
function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
}

/**
 * `data:image/jpeg;base64,…` → bytes.
 *
 * Every refusal says what to do about it, because this one is read by somebody
 * standing over a drag-and-drop box wondering why nothing happened.
 */
export function decodeDataUrl(value: string | null | undefined): DecodedImage {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, message: 'No file arrived. Try dropping it again.' };

  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(raw);
  if (!m) return { ok: false, message: 'That file could not be read as an image. JPEG, PNG or WebP work best.' };

  const declared = m[1].toLowerCase();
  const ext = ALLOWED_IMAGE_TYPES[declared];
  if (!ext) {
    return {
      ok: false,
      message: 'This app can post JPEG, PNG, WebP or GIF. That file is ' + declared + '.',
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2], 'base64');
  } catch {
    return { ok: false, message: 'That file arrived damaged. Try dropping it again.' };
  }
  if (!bytes.length) return { ok: false, message: 'That file is empty.' };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      message: 'That image is ' + mb(bytes.length) + '. Photographs over ' + mb(MAX_IMAGE_BYTES) +
        ' have to be exported smaller before they can be posted.',
    };
  }

  // The bytes must BE what they say they are. A JPEG header on a PDF is how a
  // public bucket ends up serving something nobody meant to publish.
  if (!looksLike(declared, bytes)) {
    return { ok: false, message: 'That file says it is ' + declared + ' but its contents are not. Try exporting it again.' };
  }
  return { ok: true, bytes, contentType: declared === 'image/jpg' ? 'image/jpeg' : declared, ext };
}

/** The first bytes every one of these formats begins with. */
export function looksLike(contentType: string, bytes: Buffer | Uint8Array): boolean {
  const b = bytes;
  if (b.length < 12) return false;
  switch (contentType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    case 'image/gif':
      return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
    case 'image/webp':
      // "RIFF" … "WEBP"
      return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    default:
      return false;
  }
}

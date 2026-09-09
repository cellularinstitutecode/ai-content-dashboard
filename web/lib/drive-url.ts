// web/lib/drive-url.ts
// The Drive file id inside a link, for the several shapes a person can paste.
//
// Rodrigo's video sheet holds Drive links, not YouTube links — the whole
// reason lib/composer.ts's parseVideoUrl (YouTube and Vimeo only) cannot be
// the front door for the Video Library. Pure, so it is unit-tested; the
// fetching lives in lib/google-sources.ts.

/** A Drive file id: the opaque token Drive puts in /file/d/<id>/ and ?id=<id>. */
const ID = /^[A-Za-z0-9_-]{20,80}$/;

export function parseDriveFileId(raw: string): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'drive.google.com' && host !== 'docs.google.com' && host !== 'drive.usercontent.google.com') return null;
  // /file/d/<id>/view — the shape the Share button produces, and the one in the sheet.
  const inPath = /\/(?:file|d)\/d?\/?([A-Za-z0-9_-]{20,80})/.exec(url.pathname)
    || /\/d\/([A-Za-z0-9_-]{20,80})/.exec(url.pathname);
  if (inPath && ID.test(inPath[1])) return inPath[1];
  // ?id=<id> — open?id=, uc?id=, and the usercontent download host.
  const q = url.searchParams.get('id');
  if (q && ID.test(q)) return q;
  return null;
}

export function isDriveUrl(raw: string): boolean {
  return parseDriveFileId(raw) !== null;
}

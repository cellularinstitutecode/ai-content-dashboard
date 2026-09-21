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

/**
 * The folder (or Shared Drive) id in whatever was pasted into DRIVE_FOLDER_ID.
 *
 * The setting asks for an id, and the address bar hands out a URL — so the
 * whole URL got pasted, Drive was asked for a file literally named
 * "https://drive.google.com/drive/folders/…", and the banner read "File not
 * found: https://…" while every video stayed unattached. Accepting what a
 * person actually copies is cheaper than explaining the difference.
 *
 * Handles: a bare id (a folder's `1…` or a Shared Drive's own `0A…` root id,
 * which is a valid parent), `/drive/folders/<id>`, `/drive/u/0/folders/<id>`,
 * `/drive/shared-drives/<id>`... and `?id=<id>`. Query strings and fragments
 * (`?usp=sharing`, `#…`) are ignored. Anything else is null, never a guess.
 */
export function parseDriveFolderId(raw: string | null | undefined): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  // Shared Drive root ids are shorter than file ids (19 chars, start with 0A);
  // folder ids look like file ids. Accept both, bare — but a real id always
  // carries a digit or a capital, which is what keeps the .env.example
  // placeholder ("replace-with-a-folder-id…") from passing as one.
  if (/^[A-Za-z0-9_-]{15,80}$/.test(value) && /[A-Z0-9]/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
  const m = /\/(?:folders|shared-drives)\/([A-Za-z0-9_-]{15,80})/.exec(url.pathname);
  if (m) return m[1];
  const q = url.searchParams.get('id');
  if (q && /^[A-Za-z0-9_-]{15,80}$/.test(q)) return q;
  return null;
}

/**
 * The address an anonymous fetcher — Metricool — should use to download a
 * public Drive file.
 *
 * WHY THERE ARE TWO. `webContentLink` (drive.google.com/uc?export=download)
 * serves the file itself only up to about 100 MB. Above that Google answers
 * with its "cannot scan this file for viruses" interstitial, and Metricool
 * stored that page AS THE VIDEO — the failure the Supabase bucket was
 * introduced to end, and the reason lib/copy-source.ts caps the Drive route at
 * DRIVE_DIRECT_MAX_BYTES.
 *
 * That interstitial is a FORM, and it posts to this host with `confirm=t`.
 * Which means the cap was never about size — a Drive copy is made by
 * `files.copy` INSIDE Drive, so a 283 MB reel never travels through this app
 * at all — it was about one warning page standing in front of the file.
 *
 * NOTHING HERE TRUSTS THAT THIS WORKS. Whether Google still honours a bare
 * `confirm=t` without a per-session token could not be checked from the
 * sandbox this was written in, so the only caller fetches the result as a
 * stranger through verifyPlayableMp4 first and throws the copy away if what
 * comes back is a web page. A guess behind a check is worth making; a guess in
 * front of Metricool is what caused all of this.
 */
export function driveDownloadUrl(fileId: string, opts: { confirm?: boolean } = {}): string {
  const id = String(fileId || '').trim();
  if (!id) return '';
  return opts.confirm
    ? 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t'
    : 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id);
}

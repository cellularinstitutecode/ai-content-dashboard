// Server-only helper: persist an Opus clip MP4 into Google Drive so the
// dashboard stops depending on Opus's short-lived signed CDN links.
//
// Opus serves finished clips from signed-ext.cdn.opus.pro with an Akamai
// 'hdnts' signed token that EXPIRES. Once it lapses the CDN returns
// "Invalid signed request / Error: 30" and drafts become unplayable.
// The fix: while the token is still valid (right when the webhook fires),
// download the bytes and copy them into a Drive folder we control, then
// store the permanent Drive link instead.
//
// Auth: a Google service account with Drive scope. Set these env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON  - the full service-account JSON (stringified)
//   DRIVE_FOLDER_ID              - target Drive folder id (shared with the SA)
// NOTE: connect/authorize this credential yourself - never commit the JSON.

import { google } from 'googleapis';
import { Readable } from 'stream';

function driveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Download the source (signed) URL and upload to Drive. Returns a stable
// webViewLink you can persist and replay any time.
export async function persistToDrive(
  sourceUrl: string,
  filename: string
): Promise<{ fileId: string; url: string }> {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('DRIVE_FOLDER_ID missing');

  const res = await fetch(sourceUrl);
  if (!res.ok) {
    // Token likely expired already - surface it so the caller can log/skip.
    throw new Error('source fetch failed: ' + res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const drive = driveClient();
  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: 'video/mp4', body: Readable.from(buf) },
    fields: 'id, webViewLink, webContentLink',
  });

    // Make the file readable by anyone with the link so <video> can stream it.
  await drive.permissions.create({
      supportsAllDrives: true,
      fileId: created.data.id as string,
      requestBody: { role: 'reader', type: 'anyone' },
  });

  const fileId = created.data.id as string;
const url =
    created.data.webContentLink ||
    'https://drive.google.com/uc?export=download&id=' + fileId;
  return { fileId, url };
}


/**
 * A copy of a Drive video that Metricool can actually fetch.
 *
 * Metricool cannot read an ordinary Drive link, so a video attached to a post
 * has to be readable by anyone holding the URL. The clinic's originals are not
 * — and making THEM public would be a sharing change nobody asked for — so
 * this copies the file into the app's own folder and opens the copy.
 *
 * The copy happens inside Drive (files.copy), so a 283 MB reel never travels
 * through this app: no download, no upload, no function memory, a second or
 * two of wall clock.
 */
export async function publicVideoCopy(fileId: string, filename: string): Promise<{ fileId: string; url: string }> {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('DRIVE_FOLDER_ID missing');
  const drive = driveClient();

  const copied = await drive.files.copy({
    fileId,
    supportsAllDrives: true,
    requestBody: { name: filename, parents: [folderId] },
    fields: 'id, webContentLink',
  });
  const copyId = copied.data.id as string;
  if (!copyId) throw new Error('drive: copy returned no id');

  await drive.permissions.create({
    supportsAllDrives: true,
    fileId: copyId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return {
    fileId: copyId,
    url: copied.data.webContentLink || 'https://drive.google.com/uc?export=download&id=' + copyId,
  };
}

/**
 * Delete a file this app created in its own folder.
 *
 * Only ever called with an id the app RECORDED when it made the file. Never with the
 * result of listing DRIVE_FOLDER_ID: that folder also holds the Opus clips, which are
 * referenced only from a draft's stored pack, and a cleanup that swept the folder for
 * anything it did not recognise would make every past clip permanently unplayable — the
 * exact failure this module was written to prevent.
 *
 * Treats "already gone" as success: a file removed by hand should not make a delete look
 * broken forever.
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const id = String(fileId || '').trim();
  if (!id) return;
  try {
    await driveClient().files.delete({ fileId: id, supportsAllDrives: true });
  } catch (e) {
    const status = (e as { code?: number; status?: number })?.code ?? (e as { status?: number })?.status;
    if (status === 404 || status === 410) return;
    throw e;
  }
}

// Shared helper: copy each finished clip's MP4 into Google Drive and swap in the
// permanent Drive URL, so BOTH the webhook (fast path) and the /api/opus/clip poll
// (fallback path) store durable links instead of Opus's short-lived signed CDN URLs.
// On a per-clip failure we keep the original Opus link so a single bad clip never
// loses the whole batch.
//
// Idempotency: clips freshly fetched from Opus never carry a driveFileId (that
// only lives on the persisted copy stored in the draft), so a driveFileId check
// on the input alone never fires and every poll re-uploads. `known` is the set
// of already-persisted clips from the draft; any Opus clip whose stable key
// matches an already-persisted one reuses that Drive file instead of uploading
// again. This is what stops the 5s poll + webhook from creating a new public
// Drive file per clip on every tick.
function clipKey(clip: any, i: number): string {
    const id = clip?.id ?? clip?.clipId ?? clip?.exportId ?? clip?.opusExport ?? clip?.export ?? clip?.preview;
    return id != null && String(id).trim() ? String(id).trim() : 'idx:' + i;
}

export async function persistClips(clips: any[], projectId: string, known: any[] = []): Promise<any[]> {
    const persisted = new Map<string, any>();
    for (let i = 0; i < known.length; i++) {
          const k = known[i];
          if (k && k.driveFileId) persisted.set(clipKey(k, i), k);
    }
    const out: any[] = [];
    for (let i = 0; i < clips.length; i++) {
          const clip = clips[i];
          if (clip && clip.driveFileId) { out.push(clip); continue; }
          // Reuse an already-uploaded Drive file for this clip if we have one.
          const prior = clip ? persisted.get(clipKey(clip, i)) : null;
          if (prior && prior.driveFileId) {
                  out.push({ ...clip, preview: prior.preview, export: prior.export, driveFileId: prior.driveFileId, opusExport: prior.opusExport ?? clip.export });
                  continue;
          }
          const src = clip?.export || clip?.preview;
          if (!src) { out.push(clip); continue; }
          try {
                  const filename = 'clip-' + projectId + '-' + (i + 1) + '.mp4';
                  const { fileId, url } = await persistToDrive(src, filename);
                  out.push({ ...clip, preview: url, export: url, driveFileId: fileId, opusExport: clip.export });
          } catch (e) {
                  out.push({ ...clip, driveError: (e as any)?.message || 'persist failed' });
          }
    }
    return out;
}

/**
 * What the shareable-copy folder actually is, asked of Drive rather than of
 * the environment.
 *
 * The health check has only ever tested that GOOGLE_SERVICE_ACCOUNT_JSON and
 * DRIVE_FOLDER_ID are non-empty, which both were for this whole project while
 * not one copy ever succeeded. Two non-empty strings say nothing about whether
 * the service account can write there.
 *
 * `driveId` is the entire answer. A service account authenticates as ITSELF
 * here — there is no `subject` on the JWT, so no domain-wide delegation — and a
 * service account owns zero bytes of Drive storage. A file it creates in an
 * ordinary My Drive folder is charged to that 0-byte quota and refused with
 * storageQuotaExceeded, every time, no matter how much space the folder's human
 * owner has. Inside a Shared Drive the file belongs to the drive and the
 * organisation is billed, so the limit never applies. `driveId` is present for
 * the second case and absent for the first.
 *
 * Never throws: this exists to diagnose a broken Drive, so it must not break
 * the page that shows it.
 */
export async function driveFolderReport(): Promise<{
  ok: boolean;
  folderId: string;
  folderName: string;
  /** Present only for a folder inside a Shared Drive. The whole diagnosis. */
  inSharedDrive: boolean;
  /** Bytes, as Drive reports them for the identity we authenticate as. */
  quota: { limit: string | null; usage: string | null };
  error: string;
}> {
  const folderId = String(process.env.DRIVE_FOLDER_ID || '').trim();
  const blank = {
    ok: false, folderId, folderName: '', inSharedDrive: false,
    quota: { limit: null as string | null, usage: null as string | null },
  };
  if (!folderId) return { ...blank, error: 'DRIVE_FOLDER_ID is not set.' };

  try {
    const drive = driveClient();
    const [folder, about] = await Promise.all([
      drive.files.get({ fileId: folderId, supportsAllDrives: true, fields: 'id, name, driveId, mimeType' }),
      // Asked separately and tolerated failing: a Shared Drive answers this
      // with the service account's own (empty) quota, which is informative
      // rather than authoritative, so it must not decide `ok`.
      drive.about.get({ fields: 'storageQuota' }).catch(() => null),
    ]);
    const q = (about?.data?.storageQuota || {}) as { limit?: string | null; usage?: string | null };
    const inSharedDrive = Boolean(folder.data.driveId);
    return {
      ok: inSharedDrive,
      folderId,
      folderName: String(folder.data.name || ''),
      inSharedDrive,
      quota: { limit: q.limit ?? null, usage: q.usage ?? null },
      error: '',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...blank, error: msg.slice(0, 300) };
  }
}

/**
 * Prove, end to end, that a video CAN be copied and served — without touching a
 * video.
 *
 * The four things that must all work are separate permissions, and each fails
 * with its own error at its own moment: create a file in the folder, open it to
 * anyone with the link, fetch it back as a stranger would, delete it again.
 * Only the last of those is visible from the health page's read-only checks, so
 * a Shared Drive could look correctly configured and still refuse the sharing
 * step — which is the difference between a post with a video and a post
 * without one.
 *
 * Writes a few bytes of text, not a video, and always cleans up. Safe to run as
 * often as anyone likes.
 */
export async function driveSelfTest(): Promise<{
  ok: boolean;
  steps: { step: 'create' | 'share' | 'fetch' | 'cleanup'; ok: boolean; detail: string }[];
}> {
  const steps: { step: 'create' | 'share' | 'fetch' | 'cleanup'; ok: boolean; detail: string }[] = [];
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    return { ok: false, steps: [{ step: 'create', ok: false, detail: 'DRIVE_FOLDER_ID is not set.' }] };
  }

  const drive = driveClient();
  let fileId = '';
  try {
    const created = await drive.files.create({
      supportsAllDrives: true,
      requestBody: { name: 'chi-drive-selftest.txt', parents: [folderId] },
      media: { mimeType: 'text/plain', body: Readable.from(Buffer.from('ok')) },
      fields: 'id, webContentLink',
    });
    fileId = String(created.data.id || '');
    if (!fileId) throw new Error('Drive returned no file id');
    steps.push({ step: 'create', ok: true, detail: 'Wrote a test file into the folder.' });

    try {
      await drive.permissions.create({
        supportsAllDrives: true,
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      steps.push({ step: 'share', ok: true, detail: 'Opened it to anyone with the link.' });

      // As a stranger: no credentials on this request at all. This is the step
      // Metricool performs, and the only one that proves the URL is reachable
      // from outside the organisation.
      const url = String(created.data.webContentLink || '') || 'https://drive.google.com/uc?export=download&id=' + fileId;
      try {
        const res = await fetch(url, { redirect: 'follow' });
        steps.push({
          step: 'fetch',
          ok: res.ok,
          detail: res.ok
            ? 'Fetched it back with no credentials, exactly as Metricool will.'
            : 'Drive answered ' + res.status + ' to an anonymous fetch, so a network could not download the video either.',
        });
      } catch (e) {
        steps.push({ step: 'fetch', ok: false, detail: 'Anonymous fetch failed: ' + (e instanceof Error ? e.message : String(e)) });
      }
    } catch (e) {
      steps.push({ step: 'share', ok: false, detail: 'Could not open it to anyone with the link: ' + (e instanceof Error ? e.message : String(e)) });
    }
  } catch (e) {
    steps.push({ step: 'create', ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  if (fileId) {
    try {
      await drive.files.delete({ fileId, supportsAllDrives: true });
      steps.push({ step: 'cleanup', ok: true, detail: 'Removed the test file.' });
    } catch (e) {
      // Left behind rather than lost: say so, because it is a stray public file.
      steps.push({ step: 'cleanup', ok: false, detail: 'Test file left in the folder (' + fileId + '): ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  return { ok: steps.every((s) => s.ok), steps };
}
